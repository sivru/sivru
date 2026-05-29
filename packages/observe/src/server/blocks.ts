// DESIGN-0021 slot 1 — read-only Blocks routes for the observe HTTP server.
//
// Three routes, all read-only (no `--writable`, no mutation — those land in
// slot 2):
//   GET /api/blocks?rootPath=<abs>              graph + diagnostics for a repo
//   GET /api/blocks/:filePath/:symbol?rootPath= single-block detail
//   GET /api/blocks/stream?rootPath=<abs>       SSE: block.updated on fs change
//
// PRIVACY NOTE (DESIGN.md §5.5): this file lives under src/server/, the
// inbound-listener surface. It imports `@sivru/search` for `computeBlockGraph`
// / `extractBlocksFromFiles` / `validateBlock` — all local-disk operations
// (the block module walks the filesystem and parses YAML; it makes no network
// calls). The SSE channel uses `node:fs.watch`, a local file-watch primitive.
// No outbound traffic originates here.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import {
  blockToJSON,
  computeBlockGraph,
  extractBlocksFromFiles,
  loadBlockConfig,
  validateBlock,
} from "@sivru/search";
import type {
  BlockDiagnostic,
  ExtractedBlock,
  GraphEdge,
  SivruBlockJSON,
  SourceRange,
} from "@sivru/search";

import { probeGit } from "../coach/git-stats.js";

// ---------------------------------------------------------------------------
// Wire shapes (observe-specific envelope; the UI mirrors these locally the
// same way it mirrors CheckupReport in observe-ui/src/api.ts). The nested
// block / diagnostic / edge shapes ARE the @sivru/search types, so the UI
// imports those directly from @sivru/search per DESIGN-0021.
// ---------------------------------------------------------------------------

/** One graph node enriched with its parsed content + attached diagnostics. */
export type BlockNodeDetail = {
  /** Symbol name, or "(module)" for module-level blocks. */
  name: string;
  filePath: string;
  kind: "symbol" | "module";
  range: SourceRange;
  collaborators: string[];
  /** Parsed block content for the inspector; null when unparseable. */
  block: SivruBlockJSON | null;
  /** Diagnostics whose source range falls on this node. */
  diagnostics: BlockDiagnostic[];
};

export type BlocksResponse = {
  rootPath: string;
  ranAt: string;
  nodes: BlockNodeDetail[];
  edges: GraphEdge[];
  /** Full flat diagnostic set (graph + per-block validation + drift). */
  diagnostics: BlockDiagnostic[];
};

// ---------------------------------------------------------------------------
// Path safety — same shape as the /api/checkup route (app.ts): the rootPath
// must be an existing absolute directory contained under the user's homedir
// OR inside a git working tree. Containment runs BEFORE stat so we don't leak
// the existence of paths outside the allowed surface.
// ---------------------------------------------------------------------------

type RootResult =
  | { ok: true; rootPath: string; degraded: boolean }
  | { ok: false; status: 400; code: string; error: string };

function isAbsolutePathStrict(p: string): boolean {
  if (process.platform === "win32") return /^[a-zA-Z]:[\\/]/.test(p);
  return p.startsWith("/");
}

function isUnder(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  const pTrim = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(pTrim);
}

/** Resolve + validate a `rootPath` query param. Mirrors checkupPathContained. */
export async function resolveRootPath(rawPath: string): Promise<RootResult> {
  if (rawPath.length === 0) {
    return { ok: false, status: 400, code: "SIVRU-E245", error: "missing rootPath query param" };
  }
  if (!isAbsolutePathStrict(rawPath)) {
    return { ok: false, status: 400, code: "SIVRU-E245", error: "rootPath must be absolute" };
  }
  const abs = normalize(rawPath);

  // Containment before stat (don't leak existence of paths outside the surface).
  const home = homedir();
  let allowed = isUnder(abs, home);
  let degraded = false;
  if (!allowed) {
    const probe = await probeGit(abs);
    if (probe.available) {
      allowed = true;
    } else if (probe.reason === "missing") {
      degraded = true; // git binary absent — homedir-only mode
    }
  }
  if (!allowed) {
    return { ok: false, status: 400, code: "SIVRU-E245", error: "rootPath-unsafe" };
  }

  let st: { isDirectory(): boolean };
  try {
    st = await stat(abs);
  } catch {
    return { ok: false, status: 400, code: "SIVRU-E241", error: "rootPath doesn't exist" };
  }
  if (!st.isDirectory()) {
    return { ok: false, status: 400, code: "SIVRU-E241", error: "rootPath is not a directory" };
  }
  return { ok: true, rootPath: abs, degraded };
}

/**
 * Resolve a caller-supplied filePath against rootPath, rejecting any path that
 * escapes rootPath. Returns the absolute path or null on traversal. (Slot 1 is
 * read-only, but the detail route still reads an arbitrary file off disk, so it
 * gets the same normalization the slot-2 write routes will reuse.)
 */
export function resolveFileWithinRoot(rootPath: string, filePath: string): string | null {
  const abs = isAbsolute(filePath) ? normalize(filePath) : resolve(rootPath, filePath);
  if (!isUnder(abs, rootPath)) return null;
  return abs;
}

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

function diagKey(d: BlockDiagnostic): string {
  const loc = d.location;
  return `${d.code}|${loc?.filePath ?? ""}|${loc?.startLine ?? ""}|${d.message}`;
}

function dedupeDiagnostics(diags: BlockDiagnostic[]): BlockDiagnostic[] {
  const seen = new Set<string>();
  const out: BlockDiagnostic[] = [];
  for (const d of diags) {
    const k = diagKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

/** True when `d`'s source range falls on the node at `filePath`:`startLine`. */
function diagnosticOnNode(d: BlockDiagnostic, filePath: string, range: SourceRange): boolean {
  const loc = d.location;
  if (loc === undefined) return false;
  if (loc.filePath !== filePath) return false;
  // The block's @sivru fence range; a diagnostic anchored anywhere inside it
  // (or exactly at its start) belongs to this node.
  return loc.startLine >= range.startLine && loc.startLine <= range.endLine;
}

// ---------------------------------------------------------------------------
// Core: build the BlocksResponse for a validated rootPath.
// ---------------------------------------------------------------------------

/**
 * Build the graph + enriched nodes + full diagnostic set for `rootPath`.
 *
 * Strategy: `computeBlockGraph` does the single full repo walk + extract and
 * returns nodes/edges/cross-block diagnostics (E234/E235/E236). We then
 * re-extract ONLY the block-bearing files (a small subset — one per blocked
 * symbol) to recover parsed content + per-block validation diagnostics for the
 * inspector and triage inbox. This keeps the expensive whole-repo walk to one
 * pass; the targeted re-extract is the cheap per-file path the perf gate
 * measures (<50ms / 200-block file).
 */
export async function buildBlocksResponse(rootPath: string): Promise<BlocksResponse> {
  const config = loadBlockConfig(rootPath);
  const graph = await computeBlockGraph(rootPath);

  const nodeFiles = [...new Set(graph.nodes.map((n) => n.filePath))];
  const extracted = await extractBlocksFromFiles(nodeFiles);

  // Index extracted blocks by filePath::startLine for node matching.
  const byKey = new Map<string, ExtractedBlock>();
  for (const eb of extracted) {
    byKey.set(`${eb.filePath}::${eb.range.startLine}`, eb);
  }

  // Collect every diagnostic: cross-block (graph), extraction/drift (per
  // ExtractedBlock), and full validation (validateBlock on parsed blocks).
  const allDiagnostics: BlockDiagnostic[] = [...graph.diagnostics];
  for (const eb of extracted) {
    allDiagnostics.push(...eb.diagnostics);
    if (eb.block !== null) {
      allDiagnostics.push(...validateBlock(eb.block, { location: eb.range, config }));
    }
  }
  const diagnostics = dedupeDiagnostics(allDiagnostics);

  const nodes: BlockNodeDetail[] = graph.nodes.map((n) => {
    const eb = byKey.get(`${n.filePath}::${n.range.startLine}`);
    const nodeDiags = diagnostics.filter((d) => diagnosticOnNode(d, n.filePath, n.range));
    return {
      name: n.name,
      filePath: n.filePath,
      kind: eb?.kind ?? "symbol",
      range: n.range,
      collaborators: n.collaborators,
      block: eb?.block != null ? blockToJSON(eb.block) : null,
      diagnostics: nodeDiags,
    };
  });

  return {
    rootPath,
    ranAt: new Date().toISOString(),
    nodes,
    edges: graph.edges,
    diagnostics,
  };
}

/** Detail for a single block, identified by file + symbol. Null if not found. */
export async function buildBlockDetail(
  rootPath: string,
  filePath: string,
  symbol: string,
): Promise<BlockNodeDetail | null> {
  const config = loadBlockConfig(rootPath);
  const extracted = await extractBlocksFromFiles([filePath]);
  // Module-level blocks report their symbol as "(module)" in the graph.
  const match = extracted.find((eb) => {
    const name = eb.symbolName ?? "(module)";
    return name === symbol || (symbol === "(module)" && eb.kind === "module");
  });
  if (match === undefined) return null;

  const diags: BlockDiagnostic[] = [...match.diagnostics];
  if (match.block !== null) {
    diags.push(...validateBlock(match.block, { location: match.range, config }));
  }
  return {
    name: match.symbolName ?? "(module)",
    filePath: match.filePath,
    kind: match.kind,
    range: match.range,
    collaborators: match.block?.collaborators ?? [],
    block: match.block != null ? blockToJSON(match.block) : null,
    diagnostics: dedupeDiagnostics(diags),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** Debounce window for fs.watch → SSE coalescing (DESIGN-0021 §"Live updates"). */
const SSE_DEBOUNCE_MS = 50;

/**
 * Test seam — routes call through this object so a test can substitute a
 * throwing implementation to exercise the 5xx path (mirrors the
 * `_initInternal.spawn` seam in commands/observe.ts).
 */
export const _internal = {
  buildBlocksResponse,
  buildBlockDetail,
};

export function mountBlockRoutes(app: Hono): void {
  // GET /api/blocks?rootPath=<abs>
  app.get("/api/blocks", async (c) => {
    const root = await resolveRootPath(c.req.query("rootPath") ?? "");
    if (!root.ok) {
      return c.json({ error: root.error, code: root.code }, root.status);
    }
    try {
      const body = await _internal.buildBlocksResponse(root.rootPath);
      return c.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to build block graph: ${message}`, code: "SIVRU-E246" }, 500);
    }
  });

  // GET /api/blocks/stream?rootPath=<abs> — SSE for CLI↔UI awareness.
  // Registered before the two-segment :filePath/:symbol route; "stream" is a
  // single trailing segment so it never collides with the detail route anyway.
  app.get("/api/blocks/stream", async (c) => {
    const root = await resolveRootPath(c.req.query("rootPath") ?? "");
    if (!root.ok) {
      return c.json({ error: root.error, code: root.code }, root.status);
    }
    const rootPath = root.rootPath;
    return streamSSE(c, async (stream) => {
      let watcher: FSWatcher | null = null;
      // Debounce by file path: collapse a burst of fs events (and Windows
      // duplicate fires) for the same file into one block.updated.
      const pending = new Map<string, ReturnType<typeof setTimeout>>();
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const emitUpdated = (relPath: string): void => {
        void stream
          .writeSSE({
            event: "block.updated",
            data: JSON.stringify({ filePath: relPath, ts: new Date().toISOString() }),
          })
          .catch(() => {
            // Stream gone — teardown happens via onAbort.
          });
      };

      const onChange = (_event: string, filename: string | null): void => {
        if (filename === null) return;
        // Only care about source-ish files; .sivru/ config + lockfiles churn.
        const existing = pending.get(filename);
        if (existing !== undefined) clearTimeout(existing);
        pending.set(
          filename,
          setTimeout(() => {
            pending.delete(filename);
            emitUpdated(filename);
          }, SSE_DEBOUNCE_MS),
        );
      };

      const cleanup = (): void => {
        if (watcher !== null) {
          watcher.close();
          watcher = null;
        }
        for (const t of pending.values()) clearTimeout(t);
        pending.clear();
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };

      try {
        // Recursive watch works on macOS + Windows and on Linux (Node 20+).
        // Fall back to a shallow watch if recursive isn't supported.
        try {
          watcher = watch(rootPath, { recursive: true }, onChange);
        } catch {
          watcher = watch(rootPath, onChange);
        }
        watcher.on("error", () => {
          // Best-effort; a watch error shouldn't kill the stream.
        });
      } catch {
        // Could not establish a watcher at all — keep the stream open (the
        // client still gets heartbeats) but emit nothing.
      }

      stream.onAbort(cleanup);

      // Heartbeat keeps proxies/browsers from idle-closing the stream.
      heartbeat = setInterval(() => {
        if (stream.closed || stream.aborted) return;
        void stream.write(": ping\n\n").catch(() => {});
      }, 15_000);

      // Hold the handler open until the client disconnects.
      await new Promise<void>((resolveHold) => {
        const finish = (): void => {
          cleanup();
          resolveHold();
        };
        stream.onAbort(finish);
        const closeWatch = setInterval(() => {
          if (stream.closed || stream.aborted) {
            clearInterval(closeWatch);
            finish();
          }
        }, 1000);
      });
    });
  });

  // GET /api/blocks/:filePath/:symbol?rootPath=<abs>
  // filePath is URL-encoded by the client (encodeURIComponent), so an embedded
  // "/" arrives as %2F and stays a single path segment.
  app.get("/api/blocks/:filePath/:symbol", async (c) => {
    const root = await resolveRootPath(c.req.query("rootPath") ?? "");
    if (!root.ok) {
      return c.json({ error: root.error, code: root.code }, root.status);
    }
    const rawFile = decodeURIComponent(c.req.param("filePath"));
    const symbol = decodeURIComponent(c.req.param("symbol"));
    const abs = resolveFileWithinRoot(root.rootPath, rawFile);
    if (abs === null) {
      return c.json({ error: "filePath escapes rootPath", code: "SIVRU-E247" }, 400);
    }
    try {
      const detail = await _internal.buildBlockDetail(root.rootPath, abs, symbol);
      if (detail === null) {
        return c.json({ error: "block not found", code: "SIVRU-E248" }, 404);
      }
      return c.json(detail);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to read block: ${message}`, code: "SIVRU-E246" }, 500);
    }
  });
}
