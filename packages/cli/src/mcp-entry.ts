// MCP server entry point. Spawned by Claude Code (and other MCP clients) via:
//   claude mcp add sivru -s user -- npx -y sivru mcp
//
// Wires the SDK's stdio transport to a Server that advertises two tools:
//   search        — hybrid lexical+semantic by default; `hybrid: false` falls
//                   back to BM25-only (offline / faster cold start)
//   find_related  — find chunks similar to a (filePath, startLine, endLine)
//                   region. Uses cosine over the source chunk's embedding
//                   when available, else BM25 over its tokens.
//
// We deliberately avoid importing `zod` from this file: `zod` is a peer dep of
// the SDK but not declared by `sivru` itself, so a direct import wouldn't
// resolve at runtime. Instead we use the request-schema constants the SDK
// re-exports, hand-write JSON Schema for the tool inputs, and validate the
// arguments manually inside each handler.

import { resolve as resolvePath } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildIndex } from "@sivru/search";
import type { SearchHit, SivruIndex } from "@sivru/search";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const SERVER_NAME = "sivru";
const SERVER_VERSION = "0.0.0";

// ---------------------------------------------------------------------------
// Tool surface — the JSON-Schema we advertise via tools/list.
// ---------------------------------------------------------------------------

const SEARCH_TOOL_NAME = "search";
const SEARCH_TOOL_DESCRIPTION =
  "Search a local code repository. Returns ranked chunks with file path, line range, and a code preview. Defaults to hybrid mode (BM25 + semantic embeddings, RRF-merged) — pass `hybrid: false` to use BM25-only.";
const SEARCH_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    query: { type: "string", minLength: 1 },
    path: { type: "string", default: "." },
    top: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    hybrid: { type: "boolean", default: true },
  },
  required: ["query"],
};

const FIND_RELATED_TOOL_NAME = "find_related";
const FIND_RELATED_TOOL_DESCRIPTION =
  "Find code chunks similar to a given file region. Returns ranked similar chunks based on the embedded representation of the source region (or BM25 lexical similarity when embeddings aren't available).";
const FIND_RELATED_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    filePath: { type: "string" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    path: { type: "string", default: "." },
    top: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    hybrid: { type: "boolean", default: true },
  },
  required: ["filePath", "startLine", "endLine"],
};

// ---------------------------------------------------------------------------
// MCP tool result helpers (shape mirrors `CallToolResultSchema`).
// ---------------------------------------------------------------------------

export type ToolTextContent = { type: "text"; text: string };
export type ToolResult = {
  content: ToolTextContent[];
  isError: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// Index cache — keyed by (absolute path, hybrid flag). We store the in-flight
// Promise so concurrent calls share the same build.
// ---------------------------------------------------------------------------

type IndexCacheKey = string;
type IndexCacheEntry = {
  promise: Promise<SivruIndex>;
  builds: number;
};

const indexCache = new Map<IndexCacheKey, IndexCacheEntry>();

function cacheKey(absPath: string, hybrid: boolean): IndexCacheKey {
  return `${hybrid ? "h" : "b"}:${absPath}`;
}

/**
 * Test-only hook: the count of times `getOrBuildIndex` has actually invoked
 * `buildIndex` for a given key. Cache hits do NOT increment.
 */
export function _indexBuildCountForTest(absPath: string, hybrid: boolean): number {
  return indexCache.get(cacheKey(absPath, hybrid))?.builds ?? 0;
}

/** Test-only hook: clear the per-process index cache between cases. */
export function _clearIndexCacheForTest(): void {
  indexCache.clear();
}

async function loadHybridProvider(): Promise<{
  provider: import("@sivru/search").EmbeddingProvider;
}> {
  // Honors `sivru config set embedder <name>` — looks up the persisted
  // default and resolves it via the shared model catalog. Falls back to
  // potion when no config is set, when the persisted value is "bm25"
  // (lexical-only — caller shouldn't have entered the hybrid path), or
  // when the persisted name doesn't resolve.
  const { loadConfig } = await import("./lib/config.js");
  const { resolveModel } = await import("./lib/model-catalog.js");
  const persisted = loadConfig().embedder;

  if (persisted !== undefined && persisted !== "bm25" && persisted !== "potion") {
    const entry = resolveModel(persisted);
    if (entry !== null && entry.kind === "embed") {
      process.stderr.write(
        `sivru mcp: using configured embedder "${persisted}"\n`,
      );
      return { provider: entry.build() };
    }
    process.stderr.write(
      `sivru mcp: configured embedder "${persisted}" not registered; falling back to potion\n`,
    );
  }

  // Default: Model2Vec (potion-retrieval-32M). Orders of magnitude faster
  // than the Transformers.js path on cold-start and avoids the
  // onnxruntime-node native crash on older Node versions.
  const search = await import("@sivru/search");
  return { provider: search.createPotionProvider() };
}

async function getOrBuildIndex(
  absPath: string,
  hybrid: boolean,
): Promise<SivruIndex> {
  const key = cacheKey(absPath, hybrid);
  const existing = indexCache.get(key);
  if (existing !== undefined) {
    return existing.promise;
  }
  const promise = (async () => {
    if (hybrid) {
      const { provider } = await loadHybridProvider();
      return buildIndex(absPath, { embed: { provider } });
    }
    return buildIndex(absPath);
  })();
  // Drop the cache entry on failure so subsequent calls retry.
  promise.catch(() => {
    const current = indexCache.get(key);
    if (current !== undefined && current.promise === promise) {
      indexCache.delete(key);
    }
  });
  indexCache.set(key, { promise, builds: 1 });
  return promise;
}

// ---------------------------------------------------------------------------
// Argument parsing — pragmatic JSON-Schema-ish validation. We don't pull in
// zod just for four fields each.
// ---------------------------------------------------------------------------

type ParsedSearchArgs = {
  query: string;
  path: string;
  top: number;
  hybrid: boolean;
};

function parseSearchArgs(raw: unknown): ParsedSearchArgs | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "search: arguments must be an object" };
  }
  const args = raw as Record<string, unknown>;

  const query = args["query"];
  if (typeof query !== "string" || query.length === 0) {
    return { error: "search: `query` is required and must be a non-empty string" };
  }

  const pathArg = args["path"];
  let path = ".";
  if (pathArg !== undefined) {
    if (typeof pathArg !== "string") {
      return { error: "search: `path` must be a string" };
    }
    path = pathArg;
  }

  const topArg = args["top"];
  let top = 10;
  if (topArg !== undefined) {
    if (typeof topArg !== "number" || !Number.isInteger(topArg)) {
      return { error: "search: `top` must be an integer" };
    }
    if (topArg < 1 || topArg > 50) {
      return { error: "search: `top` must be between 1 and 50" };
    }
    top = topArg;
  }

  const hybridArg = args["hybrid"];
  let hybrid = true; // default-on; matches the JSON-Schema default and the CLI
  if (hybridArg !== undefined) {
    if (typeof hybridArg !== "boolean") {
      return { error: "search: `hybrid` must be a boolean" };
    }
    hybrid = hybridArg;
  }

  return { query, path, top, hybrid };
}

type ParsedFindRelatedArgs = {
  filePath: string;
  startLine: number;
  endLine: number;
  path: string;
  top: number;
  hybrid: boolean;
};

function parseFindRelatedArgs(
  raw: unknown,
): ParsedFindRelatedArgs | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "find_related: arguments must be an object" };
  }
  const args = raw as Record<string, unknown>;

  const filePath = args["filePath"];
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { error: "find_related: `filePath` is required" };
  }
  const startLine = args["startLine"];
  if (typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 1) {
    return { error: "find_related: `startLine` must be an integer >= 1" };
  }
  const endLine = args["endLine"];
  if (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < 1) {
    return { error: "find_related: `endLine` must be an integer >= 1" };
  }
  if (endLine < startLine) {
    return { error: "find_related: `endLine` must be >= `startLine`" };
  }

  const pathArg = args["path"];
  let path = ".";
  if (pathArg !== undefined) {
    if (typeof pathArg !== "string") {
      return { error: "find_related: `path` must be a string" };
    }
    path = pathArg;
  }

  const topArg = args["top"];
  let top = 10;
  if (topArg !== undefined) {
    if (typeof topArg !== "number" || !Number.isInteger(topArg)) {
      return { error: "find_related: `top` must be an integer" };
    }
    if (topArg < 1 || topArg > 50) {
      return { error: "find_related: `top` must be between 1 and 50" };
    }
    top = topArg;
  }

  const hybridArg = args["hybrid"];
  let hybrid = true;
  if (hybridArg !== undefined) {
    if (typeof hybridArg !== "boolean") {
      return { error: "find_related: `hybrid` must be a boolean" };
    }
    hybrid = hybridArg;
  }

  return { filePath, startLine, endLine, path, top, hybrid };
}

// ---------------------------------------------------------------------------
// Tool implementations — exported so tests can call them without a transport.
// ---------------------------------------------------------------------------

/**
 * Markdown-friendly preview of a single chunk — what the LLM reads. The
 * agent processes fenced code most efficiently per DESIGN.md §6.11. We
 * include this alongside the structured fields so callers don't have to
 * re-fetch the file to render results.
 */
function previewMarkdown(hit: SearchHit): string {
  const { chunk, score } = hit;
  const lang = chunk.language ?? "text";
  const header = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}  ·  score ${score.toFixed(4)}`;
  return `${header}\n\`\`\`${lang}\n${chunk.content}\n\`\`\``;
}

/**
 * Structured search-result envelope. The agent gets enough metadata to
 * reason about cost (latencyMs, mode), enough preview to quote chunks
 * inline, and enough structure to navigate (filePath, startLine,
 * endLine). The observe-ui pulls latency / per-result info from the
 * same shape — single source of truth.
 *
 * Fields:
 *   query, mode, top, hybrid     echo of the request — observability
 *   latencyMs                    end-to-end (refresh + search + format)
 *   refreshMs                    portion spent refreshing stale chunks
 *   refreshDelta                 short summary of what refresh touched
 *   resultCount                  results.length, eagerly available
 *   results[]                    ranked chunks with metadata + preview
 */
function formatSearchResultEnvelope(
  hits: readonly SearchHit[],
  meta: {
    query: string;
    hybrid: boolean;
    top: number;
    latencyMs: number;
    refreshMs: number;
    refreshDelta: { modified: number; added: number; removed: number; embedsRecomputed: number };
  },
): string {
  const envelope = {
    query: meta.query,
    mode: meta.hybrid ? "hybrid" : "bm25",
    top: meta.top,
    latencyMs: meta.latencyMs,
    refreshMs: meta.refreshMs,
    refreshDelta: meta.refreshDelta,
    resultCount: hits.length,
    results: hits.map((hit) => ({
      filePath: hit.chunk.filePath,
      startLine: hit.chunk.startLine,
      endLine: hit.chunk.endLine,
      score: hit.score,
      source: hit.source,
      language: hit.chunk.language,
      preview: previewMarkdown(hit),
    })),
  };
  // Pretty-printed for human readability when an agent prints the
  // tool_result. ~2x the bytes of compact JSON but reads cleanly in a
  // session log.
  return JSON.stringify(envelope, null, 2);
}

export async function searchTool(rawArgs: unknown): Promise<ToolResult> {
  const parsed = parseSearchArgs(rawArgs);
  if ("error" in parsed) {
    return fail(parsed.error);
  }
  const absPath = resolvePath(process.cwd(), parsed.path);
  const tStart = performance.now();
  try {
    const index = await getOrBuildIndex(absPath, parsed.hybrid);
    // CRITICAL correctness: re-walk + diff before each search. Without
    // this, the in-memory index would still serve chunks based on
    // pre-edit content for files the agent has just modified —
    // sivru.search returns "what was indexed yesterday" instead of
    // "what's on disk right now." Cheap when nothing changed (single
    // walk + stat); only re-chunks/re-embeds files whose mtime advanced.
    const tRefreshStart = performance.now();
    const refresh = await index.refreshStale();
    const refreshMs = performance.now() - tRefreshStart;
    if (refresh.modified + refresh.added + refresh.removed > 0) {
      process.stderr.write(
        `sivru mcp: refreshed ${refresh.modified} modified, ${refresh.added} new, ${refresh.removed} removed; ${refresh.embedsRecomputed} embeds recomputed (${refreshMs.toFixed(0)} ms)\n`,
      );
    }
    const hits = await (parsed.hybrid
      ? index.searchHybrid(parsed.query, parsed.top)
      : index.searchBM25(parsed.query, parsed.top));
    const latencyMs = performance.now() - tStart;
    return ok(
      formatSearchResultEnvelope(hits, {
        query: parsed.query,
        hybrid: parsed.hybrid,
        top: parsed.top,
        latencyMs: Math.round(latencyMs * 10) / 10,
        refreshMs: Math.round(refreshMs * 10) / 10,
        refreshDelta: {
          modified: refresh.modified,
          added: refresh.added,
          removed: refresh.removed,
          embedsRecomputed: refresh.embedsRecomputed,
        },
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru mcp: search error: ${message}\n`);
    return fail(`search failed: ${message}`);
  }
}

export async function findRelatedTool(rawArgs: unknown): Promise<ToolResult> {
  const parsed = parseFindRelatedArgs(rawArgs);
  if ("error" in parsed) {
    return fail(parsed.error);
  }
  const absPath = resolvePath(process.cwd(), parsed.path);
  const tStart = performance.now();
  try {
    const index = await getOrBuildIndex(absPath, parsed.hybrid);
    // Same staleness invariant as searchTool — see comment there.
    const tRefreshStart = performance.now();
    const refresh = await index.refreshStale();
    const refreshMs = performance.now() - tRefreshStart;
    const hits = await index.findRelated({
      filePath: parsed.filePath,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      k: parsed.top,
    });
    const latencyMs = performance.now() - tStart;
    if (hits.length === 0) {
      return ok(
        JSON.stringify(
          {
            query: `find_related ${parsed.filePath}:${parsed.startLine}-${parsed.endLine}`,
            mode: parsed.hybrid ? "hybrid" : "bm25",
            latencyMs: Math.round(latencyMs * 10) / 10,
            refreshMs: Math.round(refreshMs * 10) / 10,
            resultCount: 0,
            results: [],
            message: "no related chunks found",
          },
          null,
          2,
        ),
      );
    }
    return ok(
      formatSearchResultEnvelope(hits, {
        query: `find_related ${parsed.filePath}:${parsed.startLine}-${parsed.endLine}`,
        hybrid: parsed.hybrid,
        top: parsed.top,
        latencyMs: Math.round(latencyMs * 10) / 10,
        refreshMs: Math.round(refreshMs * 10) / 10,
        refreshDelta: {
          modified: refresh.modified,
          added: refresh.added,
          removed: refresh.removed,
          embedsRecomputed: refresh.embedsRecomputed,
        },
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru mcp: find_related error: ${message}\n`);
    return fail(`find_related failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Server wiring — exported so tests can drive it over an in-memory transport.
// ---------------------------------------------------------------------------

export function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: SEARCH_TOOL_NAME,
        description: SEARCH_TOOL_DESCRIPTION,
        inputSchema: SEARCH_INPUT_SCHEMA,
      },
      {
        name: FIND_RELATED_TOOL_NAME,
        description: FIND_RELATED_TOOL_DESCRIPTION,
        inputSchema: FIND_RELATED_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case SEARCH_TOOL_NAME:
          return await searchTool(args ?? {});
        case FIND_RELATED_TOOL_NAME:
          return await findRelatedTool(args ?? {});
        default:
          return fail(`unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`sivru mcp: ${name} threw: ${message}\n`);
      return fail(`${name} failed: ${message}`);
    }
  });

  return server;
}

/**
 * Connect a server to the given transport and resolve when it closes.
 * Exported separately so tests can drive a non-stdio transport.
 */
export async function runWithTransport(transport: Transport): Promise<number> {
  const server = createMcpServer();
  const closed = new Promise<void>((resolve) => {
    const prev = transport.onclose;
    transport.onclose = (): void => {
      try {
        prev?.();
      } finally {
        resolve();
      }
    };
  });
  try {
    await server.connect(transport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru mcp: failed to start: ${message}\n`);
    return 1;
  }
  await closed;
  return 0;
}

/**
 * Run the stdio MCP server. Returns exit code. Long-running — only resolves
 * when stdin closes (i.e. the parent client disconnects).
 *
 * `argv` is `process.argv.slice(2)`. It will be `["mcp", ...]` when called via
 * the dispatcher; the v0.0.0 server takes no flags.
 */
export async function runMcp(_argv: readonly string[]): Promise<number> {
  void _argv;
  const transport = new StdioServerTransport();
  return runWithTransport(transport);
}

export default runMcp;
