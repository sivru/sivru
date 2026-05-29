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
import {
  applyMcpCap,
  assembleArtifact,
  assembleDiffArtifact,
  buildCommitCounts,
  buildIndex,
  computeStateId,
  loadMcpCapConfig,
  loadOrBuildSymbolIndex,
  parsePathAndSymbol,
  resolveAndAssertInside,
  SivruExplainError,
} from "@sivru/search";
import type {
  ExplainArtifact,
  ExplainEnvelope,
  ExplainOptions,
  SearchHit,
  SivruIndex,
} from "@sivru/search";
import { runCheckup, CheckupConfigError } from "@sivru/observe/coach";
// DESIGN-0021 slot 2 — agent write surface. These are the SAME shared handlers
// the HTTP mutation routes call (single source of truth).
import {
  acknowledgeDiagnostic,
  appendFeedbackRecord,
  applyAutofix,
  readFeedbackRecords,
} from "@sivru/observe";
import type { HandlerContext, HandlerResult, FeedbackKind } from "@sivru/observe";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const SERVER_NAME = "sivru";
const SERVER_VERSION = "0.7.0";

// ---------------------------------------------------------------------------
// Tool surface — the JSON-Schema we advertise via tools/list.
// ---------------------------------------------------------------------------

const SEARCH_TOOL_NAME = "search";
// The description carries the always-on routing hint (DESIGN-0003 §1): it is
// the one channel always in the agent's context. The longer policy lives in
// the bundled SKILL.md; mcp-entry.test.ts asserts this hint stays present.
export const SEARCH_TOOL_DESCRIPTION =
  "Semantic + lexical code search over a local repository. Best for " +
  'natural-language or behavioural queries ("where is auth refresh handled", ' +
  '"how does retry backoff work"). For an exact known identifier or string, ' +
  "plain grep is faster and more precise. Returns ranked chunks with file " +
  "path, line range, and a code preview; defaults to hybrid mode (BM25 + " +
  "semantic embeddings, RRF-merged) — pass `hybrid: false` for BM25-only.";
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

const EXPLAIN_TOOL_NAME = "explain";
// Routing hint: the before-edit workflow. See SEARCH_TOOL_DESCRIPTION note.
export const EXPLAIN_TOOL_DESCRIPTION =
  "Get the public API, callers, callees, churn, and ownership of a file or " +
  "symbol before editing it. Use after locating a file and before changing " +
  "a symbol — it surfaces who else depends on what you are about to touch. " +
  "Pass `path: \"<file>::<symbol>\"` for a region-level view. `diff: true` " +
  "shows what an in-progress edit is about to break.";
const EXPLAIN_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    path: { type: "string", minLength: 1 },
    symbol: { type: "string" },
    diff: { type: "boolean", default: false },
    since: { type: "integer", minimum: 0, default: 90 },
    depth: { type: "integer", minimum: 1, maximum: 1, default: 1 },
    repoRoot: { type: "string", default: "." },
  },
  required: ["path"],
};

const CHECKUP_TOOL_NAME = "checkup";
// Routing hint: the trust-the-memory-file workflow. Before reading
// CLAUDE.md / a SKILL.md / an agent file as authoritative, this tool
// tells you whether it's aged or has dead references — staleness is
// data, not judgment.
export const CHECKUP_TOOL_DESCRIPTION =
  "Inspect Claude Code memory files (CLAUDE.md, SKILL.md, agent " +
  "files) for drift against the current repo state. Returns three " +
  "built-in checks: memory-claude-age (descriptive file age + churn), " +
  "memory-dead-reference (inline-code path mentions that no longer " +
  "resolve), and memory-skill-tools-drift (front-matter `tools:` " +
  "entries that name no built-in or discoverable subagent). Use " +
  "before trusting a memory file you didn't just edit.";
const CHECKUP_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    path: { type: "string", default: "." },
    noGit: { type: "boolean", default: false },
    check: { type: "array", items: { type: "string" } },
  },
  required: [],
};

const FIND_RELATED_TOOL_NAME = "find_related";
// Routing hint: the after-edit workflow. See SEARCH_TOOL_DESCRIPTION note.
export const FIND_RELATED_TOOL_DESCRIPTION =
  "Find code related to a symbol or file region — callers, tests, and " +
  "similar code. Use it after editing a symbol, before you finish, to catch " +
  "code your change may have affected. Returns ranked similar chunks from " +
  "the embedded representation of the source region (or BM25 lexical " +
  "similarity when embeddings aren't available).";
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

type ParsedExplainArgs = {
  path: string;
  symbol: string | null;
  diff: boolean;
  sinceDays: number;
  depth: number;
  repoRoot: string;
};

export function parseExplainArgs(
  raw: unknown,
): ParsedExplainArgs | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "explain: arguments must be an object" };
  }
  const args = raw as Record<string, unknown>;

  const pathArg = args["path"];
  if (typeof pathArg !== "string" || pathArg.length === 0) {
    return { error: "explain: `path` is required and must be a non-empty string" };
  }

  // Symbol may be encoded either inside the `path` via `::` or as a separate
  // `symbol` arg. We support both shapes; an explicit `symbol` arg wins.
  let path = pathArg;
  let symbol: string | null = null;
  const parsedPath = parsePathAndSymbol(pathArg);
  if (parsedPath.symbol !== null) {
    path = parsedPath.path;
    symbol = parsedPath.symbol;
  }
  const symbolArg = args["symbol"];
  if (symbolArg !== undefined) {
    if (typeof symbolArg !== "string") {
      return { error: "explain: `symbol` must be a string if provided" };
    }
    symbol = symbolArg.length > 0 ? symbolArg : null;
  }

  const diffArg = args["diff"];
  let diff = false;
  if (diffArg !== undefined) {
    if (typeof diffArg !== "boolean") {
      return { error: "explain: `diff` must be a boolean if provided" };
    }
    diff = diffArg;
  }

  const sinceArg = args["since"];
  let sinceDays = 90;
  if (sinceArg !== undefined) {
    if (
      typeof sinceArg !== "number" ||
      !Number.isInteger(sinceArg) ||
      sinceArg < 0
    ) {
      return { error: "explain: `since` must be a non-negative integer" };
    }
    sinceDays = sinceArg;
  }

  const depthArg = args["depth"];
  let depth = 1;
  if (depthArg !== undefined) {
    if (depthArg !== 1) {
      return { error: "explain: `depth` must be 1 in v0.5" };
    }
    depth = 1;
  }

  const repoArg = args["repoRoot"];
  let repoRoot = ".";
  if (repoArg !== undefined) {
    if (typeof repoArg !== "string") {
      return { error: "explain: `repoRoot` must be a string" };
    }
    repoRoot = repoArg;
  }

  return { path, symbol, diff, sinceDays, depth, repoRoot };
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

/**
 * MCP envelope for the explain tool (DESIGN-0004 §1). Returns the canonical
 * artifact wrapped with `tool`, `path`, `latencyMs`, `refreshMs`, and
 * `refreshDelta`. The CLI does NOT wrap — `sivru explain --json` returns the
 * bare artifact. Only the MCP path adds the envelope.
 */
export function formatExplainEnvelope(
  artifact: ExplainArtifact,
  meta: {
    latencyMs: number;
    refreshMs: number;
    refreshDelta: ExplainEnvelope["refreshDelta"];
  },
): string {
  const envelope: ExplainEnvelope = {
    tool: "sivru.explain",
    path: artifact.path,
    latencyMs: meta.latencyMs,
    refreshMs: meta.refreshMs,
    refreshDelta: meta.refreshDelta,
    artifact,
  };
  return JSON.stringify(envelope, null, 2);
}

export async function explainTool(rawArgs: unknown): Promise<ToolResult> {
  const parsed = parseExplainArgs(rawArgs);
  if ("error" in parsed) {
    return fail(parsed.error);
  }
  const absRepo = resolvePath(process.cwd(), parsed.repoRoot);
  const tStart = performance.now();
  try {
    // Path validator (T13). Reject absolute paths, `..` escapes, and
    // symlinks that exit the repo before any indexing work happens.
    await resolveAndAssertInside(parsed.path, absRepo);

    // stateId snapshots the on-disk state (commit sha or dirty hash). The
    // symbol-index cache is keyed on it, so an edit between two MCP calls
    // produces a different stateId → fresh build. That's the explain
    // analogue of search's refreshStale.
    const tRefreshStart = performance.now();
    const stateId = await computeStateId(absRepo);
    const commitCounts = await buildCommitCounts(absRepo, {
      sinceDays: parsed.sinceDays,
    });
    const { index, fromCache } = await loadOrBuildSymbolIndex(
      absRepo,
      stateId,
      { commitCounts },
    );
    const refreshMs = performance.now() - tRefreshStart;

    const explainOpts: ExplainOptions = {
      repoRoot: absRepo,
      target: parsed.path,
      sinceDays: parsed.sinceDays,
      depth: parsed.depth,
    };
    if (parsed.symbol !== null) explainOpts.symbol = parsed.symbol;
    const rawArtifact = parsed.diff
      ? await assembleDiffArtifact(explainOpts, index)
      : await assembleArtifact(explainOpts, index);
    // T11: apply the MCP cap. CLI is uncapped — MCP capping happens here.
    const cap = await loadMcpCapConfig(absRepo);
    const artifact = applyMcpCap(rawArtifact, cap);

    const latencyMs = performance.now() - tStart;
    return ok(
      formatExplainEnvelope(artifact, {
        latencyMs: Math.round(latencyMs * 10) / 10,
        refreshMs: Math.round(refreshMs * 10) / 10,
        refreshDelta: {
          // The explain index is rebuilt-or-not in one shot — there's no
          // file-level partial refresh in v0.5 (T19 may revisit). Surface
          // the binary signal as 0/0/0/0 on cache-hit and 0/<size>/0/0 on
          // a rebuild so observability still has a hook.
          modified: 0,
          added: fromCache ? 0 : index.size(),
          removed: 0,
          embedsRecomputed: 0,
        },
      }),
    );
  } catch (err) {
    if (err instanceof SivruExplainError) {
      return fail(`${err.code}: ${err.message.replace(`${err.code}: `, "")}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru mcp: explain error: ${message}\n`);
    return fail(`explain failed: ${message}`);
  }
}

/**
 * MCP envelope for the checkup tool (DESIGN-0005 §2). Returns the full
 * CheckupReport JSON shape.
 */
async function checkupTool(args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = typeof args["path"] === "string" ? args["path"] : ".";
  const path = resolvePath(rawPath);
  const noGit = args["noGit"] === true;
  const checkArg = args["check"];
  const check = Array.isArray(checkArg)
    ? checkArg.filter((s): s is string => typeof s === "string")
    : undefined;

  try {
    const report = await runCheckup(path, {
      noGit,
      ...(check !== undefined && check.length > 0 ? { check } : {}),
    });
    return ok(JSON.stringify(report));
  } catch (err) {
    if (err instanceof CheckupConfigError) {
      return fail(`${err.code}: ${err.message}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail(`checkup failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Server wiring — exported so tests can drive it over an in-memory transport.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DESIGN-0021 slot 2 — agent write surface (4 tools). All route through the
// shared @sivru/observe handlers, gated by `--writable` on `sivru mcp`.
// ---------------------------------------------------------------------------

const BLOCK_AUTOFIX_TOOL_NAME = "block_autofix";
const BLOCK_ACKNOWLEDGE_TOOL_NAME = "block_acknowledge";
const FEEDBACK_APPEND_TOOL_NAME = "feedback_append";
const FEEDBACK_READ_TOOL_NAME = "feedback_read";

const ROOT_PATH_PROP = {
  rootPath: { type: "string", description: "Absolute path to the repo root." },
} as const;
const DIAGNOSTIC_PROP = {
  diagnostic: {
    type: "object",
    properties: {
      code: { type: "string" },
      filePath: { type: "string" },
      symbolName: { type: "string" },
    },
    required: ["code", "filePath", "symbolName"],
  },
} as const;

const BLOCK_AUTOFIX_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    ...ROOT_PATH_PROP,
    filePath: { type: "string", description: "Repo-relative or absolute file to autofix." },
    diagnosticCode: { type: "string", description: "Optional SIVRU-EXXX that triggered the fix." },
  },
  required: ["rootPath", "filePath"],
};
const BLOCK_ACKNOWLEDGE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: { ...ROOT_PATH_PROP, ...DIAGNOSTIC_PROP, note: { type: "string" } },
  required: ["rootPath", "diagnostic"],
};
const FEEDBACK_APPEND_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    ...ROOT_PATH_PROP,
    ...DIAGNOSTIC_PROP,
    kind: { type: "string", enum: ["acknowledge", "false-positive", "suggest"] },
    label: { type: "string" },
    note: { type: "string" },
  },
  required: ["rootPath", "kind", "diagnostic", "label"],
};
const FEEDBACK_READ_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    ...ROOT_PATH_PROP,
    kind: { type: "string", enum: ["acknowledge", "false-positive", "suggest"] },
    code: { type: "string" },
  },
  required: ["rootPath"],
};

const BLOCK_WRITE_TOOL_DESCRIPTIONS: Record<string, string> = {
  [BLOCK_AUTOFIX_TOOL_NAME]:
    "Apply the @sivru YAML-trap autofixer (E237/E238) to a file. Requires the server started with --writable.",
  [BLOCK_ACKNOWLEDGE_TOOL_NAME]:
    "Record a diagnostic as intentional (acknowledgment). Requires --writable.",
  [FEEDBACK_APPEND_TOOL_NAME]:
    "Append a feedback record (acknowledge / false-positive / suggest). Requires --writable.",
  [FEEDBACK_READ_TOOL_NAME]: "Read feedback records for a repo. Always allowed (no --writable needed).",
};

/** Render a HandlerResult as an MCP tool result (the structured envelope). */
function mcpResult(r: HandlerResult<unknown>): ToolResult {
  const text = JSON.stringify(r);
  return r.ok ? ok(text) : fail(text);
}

function mcpCtx(args: Record<string, unknown>, writable: boolean): HandlerContext | null {
  const raw = args["rootPath"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return { rootPath: resolvePath(raw), actor: "mcp", writable };
}

async function blockAutofixTool(args: Record<string, unknown>, writable: boolean): Promise<ToolResult> {
  const ctx = mcpCtx(args, writable);
  if (ctx === null) return fail("block_autofix: rootPath is required");
  const r = await applyAutofix(
    ctx,
    typeof args["filePath"] === "string" ? args["filePath"] : "",
    typeof args["diagnosticCode"] === "string" ? args["diagnosticCode"] : undefined,
  );
  return mcpResult(r);
}

async function blockAcknowledgeTool(args: Record<string, unknown>, writable: boolean): Promise<ToolResult> {
  const ctx = mcpCtx(args, writable);
  if (ctx === null) return fail("block_acknowledge: rootPath is required");
  const d = (args["diagnostic"] ?? {}) as Record<string, unknown>;
  const r = await acknowledgeDiagnostic(
    ctx,
    { code: String(d["code"] ?? ""), filePath: String(d["filePath"] ?? ""), symbolName: String(d["symbolName"] ?? "") },
    typeof args["note"] === "string" ? args["note"] : undefined,
  );
  return mcpResult(r);
}

async function feedbackAppendTool(args: Record<string, unknown>, writable: boolean): Promise<ToolResult> {
  const ctx = mcpCtx(args, writable);
  if (ctx === null) return fail("feedback_append: rootPath is required");
  const d = (args["diagnostic"] ?? {}) as Record<string, unknown>;
  const r = await appendFeedbackRecord(
    ctx,
    String(args["kind"] ?? "suggest") as FeedbackKind,
    { code: String(d["code"] ?? ""), filePath: String(d["filePath"] ?? ""), symbolName: String(d["symbolName"] ?? "") },
    String(args["label"] ?? ""),
    typeof args["note"] === "string" ? args["note"] : undefined,
  );
  return mcpResult(r);
}

async function feedbackReadTool(args: Record<string, unknown>): Promise<ToolResult> {
  // Reads are ungated — pass writable:false; readFeedbackRecords ignores it.
  const ctx = mcpCtx(args, false);
  if (ctx === null) return fail("feedback_read: rootPath is required");
  const kind = typeof args["kind"] === "string" ? (args["kind"] as FeedbackKind) : undefined;
  const code = typeof args["code"] === "string" ? args["code"] : undefined;
  const r = await readFeedbackRecords(ctx, {
    ...(kind !== undefined ? { kind } : {}),
    ...(code !== undefined ? { code } : {}),
  });
  return mcpResult(r);
}

export function createMcpServer(opts?: { writable?: boolean }): Server {
  const writable = opts?.writable === true;
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
      {
        name: EXPLAIN_TOOL_NAME,
        description: EXPLAIN_TOOL_DESCRIPTION,
        inputSchema: EXPLAIN_INPUT_SCHEMA,
      },
      {
        name: CHECKUP_TOOL_NAME,
        description: CHECKUP_TOOL_DESCRIPTION,
        inputSchema: CHECKUP_INPUT_SCHEMA,
      },
      {
        name: BLOCK_AUTOFIX_TOOL_NAME,
        description: BLOCK_WRITE_TOOL_DESCRIPTIONS[BLOCK_AUTOFIX_TOOL_NAME]!,
        inputSchema: BLOCK_AUTOFIX_INPUT_SCHEMA,
      },
      {
        name: BLOCK_ACKNOWLEDGE_TOOL_NAME,
        description: BLOCK_WRITE_TOOL_DESCRIPTIONS[BLOCK_ACKNOWLEDGE_TOOL_NAME]!,
        inputSchema: BLOCK_ACKNOWLEDGE_INPUT_SCHEMA,
      },
      {
        name: FEEDBACK_APPEND_TOOL_NAME,
        description: BLOCK_WRITE_TOOL_DESCRIPTIONS[FEEDBACK_APPEND_TOOL_NAME]!,
        inputSchema: FEEDBACK_APPEND_INPUT_SCHEMA,
      },
      {
        name: FEEDBACK_READ_TOOL_NAME,
        description: BLOCK_WRITE_TOOL_DESCRIPTIONS[FEEDBACK_READ_TOOL_NAME]!,
        inputSchema: FEEDBACK_READ_INPUT_SCHEMA,
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
        case EXPLAIN_TOOL_NAME:
          return await explainTool(args ?? {});
        case CHECKUP_TOOL_NAME:
          return await checkupTool(args ?? {});
        case BLOCK_AUTOFIX_TOOL_NAME:
          return await blockAutofixTool(args ?? {}, writable);
        case BLOCK_ACKNOWLEDGE_TOOL_NAME:
          return await blockAcknowledgeTool(args ?? {}, writable);
        case FEEDBACK_APPEND_TOOL_NAME:
          return await feedbackAppendTool(args ?? {}, writable);
        case FEEDBACK_READ_TOOL_NAME:
          return await feedbackReadTool(args ?? {});
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
export async function runWithTransport(
  transport: Transport,
  opts?: { writable?: boolean },
): Promise<number> {
  const server = createMcpServer(opts);
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
 *
 * @sivru
 * schema: 1
 * role: mcp-server
 * responsibility: run the sivru MCP server on stdio so coding agents (Claude Code, Cursor, etc.) can call sivru.search / sivru.explain
 * collaborators: [buildIndex, assembleArtifact, runWithTransport]
 * invariants:
 *   - the server reads JSON-RPC framed on stdin and writes responses to stdout; logs go to stderr
 *   - the server lifecycle ends when stdin closes (parent client disconnect)
 * decisions:
 *   - chose: stdio transport rather than a network listener
 *     because: matches the dominant agent integration pattern (Claude Code MCP); no port allocation or auth surface
 *     valid-while: agent runtimes default to stdio MCP
 *     revisit-if: a meaningful agent target ships with a network-MCP-only convention
 * maturity: stable
 * @end
 */
export async function runMcp(argv: readonly string[]): Promise<number> {
  // DESIGN-0021 slot 2: `sivru mcp --writable` enables the block/feedback write
  // tools (default off → they return SIVRU-WRITABLE-DISABLED). Symmetric with
  // `sivru observe --writable`; the stdio transport is per-process so trust is
  // the same as any CLI invocation.
  const writable = argv.includes("--writable");
  if (writable) {
    process.stderr.write("sivru mcp: WRITABLE — block_autofix / block_acknowledge / feedback_append enabled\n");
  }
  const transport = new StdioServerTransport();
  return runWithTransport(transport, { writable });
}

export default runMcp;
