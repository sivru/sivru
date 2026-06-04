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

import type { Context, Hono } from "hono";
import { csrf } from "hono/csrf";
import { streamSSE } from "hono/streaming";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { normalize } from "node:path";

import {
  blockToJSON,
  computeBlockGraph,
  extractBlocksFromFiles,
  hashBlockContent,
  loadBlockConfig,
  validateBlock,
} from "@sivru/search";
import type { GraphNode } from "@sivru/search";
import { readAcknowledgments } from "../feedback/index.js";
import { defaultSubview, loadObserveConfig } from "../config.js";
import type {
  BlockDiagnostic,
  ExtractedBlock,
  GraphEdge,
  SivruBlockJSON,
  SourceRange,
} from "@sivru/search";

import {
  isAbsolutePathStrict,
  isLocalhostOrigin,
  pathContainment,
  resolveFileWithinRoot,
} from "./path-safety.js";
import {
  acknowledgeDiagnostic,
  appendFeedbackRecord,
  applyAutofix,
  editBlock,
  readFeedbackRecords,
  type HandlerContext,
} from "../handlers/block/index.js";
import { httpStatusFor, type HandlerResult } from "../handlers/block/result.js";
import type { FeedbackKind } from "../feedback/index.js";

export { resolveFileWithinRoot } from "./path-safety.js";

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
  /** Source file mtime (detail route only) — the editor's 409 save baseline. */
  mtimeMs?: number;
};

export type BlocksResponse = {
  rootPath: string;
  ranAt: string;
  nodes: BlockNodeDetail[];
  edges: GraphEdge[];
  /** Full flat diagnostic set (graph + per-block validation + drift). */
  diagnostics: BlockDiagnostic[];
  /** Count of files that had a fence but failed to parse (block:null). */
  filesSkipped: number;
  /** Declarative UI defaults from .sivru/observe.json (DESIGN-0021 layer 2). */
  ui: { defaultSubview: "issues" | "graph" };
};

// ---------------------------------------------------------------------------
// Path safety — the rootPath must be an existing absolute directory under the
// user's homedir OR inside a git working tree. The containment primitive is
// shared with the /api/checkup route (path-safety.ts) so the rule can't drift.
// ---------------------------------------------------------------------------

type RootResult =
  | { ok: true; rootPath: string; degraded: boolean }
  | { ok: false; status: 400; code: string; error: string };

/** Resolve + validate a `rootPath` query param. */
export async function resolveRootPath(rawPath: string): Promise<RootResult> {
  if (rawPath.length === 0) {
    return { ok: false, status: 400, code: "SIVRU-E245", error: "missing rootPath query param" };
  }
  if (!isAbsolutePathStrict(rawPath)) {
    return { ok: false, status: 400, code: "SIVRU-E245", error: "rootPath must be absolute" };
  }
  const abs = normalize(rawPath);

  // Containment before stat (don't leak existence of paths outside the surface).
  const containment = await pathContainment(abs);
  if (!containment.allowed) {
    return { ok: false, status: 400, code: "SIVRU-E245", error: "rootPath-unsafe" };
  }
  const degraded = containment.degraded;

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

/**
 * Suppress diagnostics the user acknowledged. An acknowledgment keys on
 * {code, filePath, symbolName, contentHash}; we drop a matching finding only
 * while the block's CURRENT content hash equals the acknowledged hash. If the
 * block changed, the finding re-fires with a "previously acknowledged" note so
 * the user re-triages it. (DESIGN-0021 §"Content-hash-keyed invalidation".)
 */
async function applyAcknowledgments(
  rootPath: string,
  diagnostics: BlockDiagnostic[],
  nodes: readonly GraphNode[],
  byKey: Map<string, ExtractedBlock>,
): Promise<BlockDiagnostic[]> {
  const acks = await readAcknowledgments(rootPath);
  if (acks.length === 0) return diagnostics;

  // key = code|filePath|symbolName → acknowledged contentHash (latest wins).
  const ackHashByKey = new Map<string, string>();
  for (const a of acks) {
    ackHashByKey.set(
      `${a.diagnostic.code}|${a.diagnostic.filePath}|${a.diagnostic.symbolName}`,
      a.diagnostic.contentHash,
    );
  }

  const out: BlockDiagnostic[] = [];
  for (const d of diagnostics) {
    const loc = d.location;
    if (loc === undefined) {
      out.push(d);
      continue;
    }
    const node = nodes.find(
      (n) => n.filePath === loc.filePath && loc.startLine >= n.range.startLine && loc.startLine <= n.range.endLine,
    );
    if (node === undefined) {
      out.push(d);
      continue;
    }
    const ackHash = ackHashByKey.get(`${d.code}|${loc.filePath}|${node.name}`);
    if (ackHash === undefined) {
      out.push(d);
      continue;
    }
    const eb = byKey.get(`${node.filePath}::${node.range.startLine}`);
    const currentHash = eb?.block != null ? hashBlockContent(eb.block) : "";
    if (ackHash === currentHash) continue; // acknowledged + unchanged → suppress
    // Block changed since the acknowledgment → re-fire with a note.
    out.push({ ...d, message: `${d.message} (previously acknowledged; block has changed since)` });
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
 * `computeBlockGraph({ withExtracted: true })` does ONE walk + extract and hands
 * back the full `ExtractedBlock[]` it built (including `block: null` parse
 * failures) alongside nodes/edges/cross-block diagnostics. We reuse that array
 * for node content + per-block validation — no second extraction pass — and
 * count unparseable files for the UI's "partial" state.
 */
export async function buildBlocksResponse(rootPath: string): Promise<BlocksResponse> {
  const config = loadBlockConfig(rootPath);
  const graph = await computeBlockGraph(rootPath, { withExtracted: true });
  const extracted = graph.extracted ?? [];

  // Index extracted blocks by filePath::startLine for node matching.
  const byKey = new Map<string, ExtractedBlock>();
  for (const eb of extracted) {
    byKey.set(`${eb.filePath}::${eb.range.startLine}`, eb);
  }

  // Files that had a fence but failed to parse (block:null) are never dropped
  // silently — count distinct ones for the "Graph built with N files skipped"
  // partial state, and surface their extraction diagnostics in the inbox.
  const skippedFiles = new Set<string>();
  for (const eb of extracted) {
    if (eb.block === null) skippedFiles.add(eb.filePath);
  }

  // Collect every diagnostic: cross-block (graph), extraction/parse failures
  // (per ExtractedBlock), and full validation (validateBlock on parsed blocks).
  const allDiagnostics: BlockDiagnostic[] = [...graph.diagnostics];
  for (const eb of extracted) {
    allDiagnostics.push(...eb.diagnostics);
    if (eb.block !== null) {
      allDiagnostics.push(...validateBlock(eb.block, { location: eb.range, config }));
    }
  }
  const deduped = dedupeDiagnostics(allDiagnostics);
  // Content-hash-keyed acknowledgment suppression (DESIGN-0021 §"Content-hash-
  // keyed invalidation"): drop a finding the user acknowledged AS LONG AS the
  // block's content hash still matches; if the block changed, the finding
  // re-fires with a note. This is what turns Acknowledge into real inbox relief.
  const diagnostics = await applyAcknowledgments(rootPath, deduped, graph.nodes, byKey);

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
    filesSkipped: skippedFiles.size,
    ui: { defaultSubview: defaultSubview(loadObserveConfig(rootPath)) },
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
  // mtime is the editor's 409 baseline; best-effort (0 if unreadable).
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return {
    name: match.symbolName ?? "(module)",
    filePath: match.filePath,
    kind: match.kind,
    range: match.range,
    collaborators: match.block?.collaborators ?? [],
    block: match.block != null ? blockToJSON(match.block) : null,
    diagnostics: dedupeDiagnostics(diags),
    mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** Debounce window for fs.watch → SSE coalescing (DESIGN-0021 §"Live updates"). */
const SSE_DEBOUNCE_MS = 50;

/** Watcher events we never want to surface as block.updated — pure churn. */
export function isWatchNoise(rel: string): boolean {
  return (
    rel.includes("node_modules") ||
    rel.includes(".git/") ||
    rel.includes(".git\\") ||
    rel.includes("/dist/") ||
    rel.startsWith("dist/") ||
    rel.endsWith(".lock") ||
    rel.endsWith("lock.yaml") ||
    rel.endsWith("lock.json")
  );
}

/**
 * Test seam — routes call through this object so a test can substitute a
 * throwing implementation to exercise the 5xx path (mirrors the
 * `_initInternal.spawn` seam in commands/observe.ts).
 */
export const _internal = {
  buildBlocksResponse,
  buildBlockDetail,
};

export interface MountBlockRoutesOptions {
  /** The --writable gate. Mutation routes still register, but return 405. */
  writable: boolean;
  /** Increment a named metrics counter. */
  bump: (key: string) => void;
}

export function mountBlockRoutes(app: Hono, opts: MountBlockRoutesOptions): void {
  const { writable, bump } = opts;

  // CSRF (DESIGN-0021 §Security): two layers on the state-changing route groups.
  //  1. hono/csrf — framework-maintained guard against form-submittable CSRF
  //     (the content-types a cross-origin <form> can send without preflight).
  //  2. An explicit localhost-Origin guard — JSON POSTs are already CORS-
  //     protected (our CORS only echoes localhost origins), but hono/csrf does
  //     not challenge application/json. This guard enforces the design's
  //     "origin-less POST → 403" contract for every unsafe method.
  // GET/HEAD/OPTIONS pass through untouched in both.
  const csrfGuard = csrf({ origin: (origin) => isLocalhostOrigin(origin) });
  const originGuard = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const m = c.req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin === undefined || !isLocalhostOrigin(origin)) {
        return c.json(
          { ok: false, code: "SIVRU-CSRF-ORIGIN", message: "origin check failed", retryable: false },
          403,
        );
      }
    }
    await next();
  };
  app.use("/api/blocks/*", csrfGuard);
  app.use("/api/blocks/*", originGuard);
  app.use("/api/feedback", csrfGuard);
  app.use("/api/feedback", originGuard);

  // GET /api/blocks?rootPath=<abs>
  app.get("/api/blocks", async (c) => {
    const root = await resolveRootPath(c.req.query("rootPath") ?? "");
    if (!root.ok) {
      return c.json({ error: root.error, code: root.code }, root.status);
    }
    try {
      const body = await _internal.buildBlocksResponse(root.rootPath);
      bump("graph_builds_total");
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
        const data = JSON.stringify({ filePath: relPath, ts: new Date().toISOString() });
        // Emit both events: block.updated (content changed) and, since an
        // external source-file write can also change collaborator topology and
        // we can't tell the two apart from a raw fs event, block.graph.rebuilt.
        // The read-only client coalesces them into a single graph refetch, so
        // the conservative double-emit is harmless and keeps the documented
        // block.graph.rebuilt event real (slot 2's write handlers will fire it
        // precisely, only when topology actually changed).
        const send = (event: string): void => {
          void stream.writeSSE({ event, data }).catch(() => {
            // Stream gone — teardown happens via onAbort.
          });
        };
        send("block.updated");
        send("block.graph.rebuilt");
      };

      const onChange = (_event: string, filename: string | null): void => {
        if (filename === null) return;
        // Skip high-churn paths that never carry a block (node_modules, VCS
        // internals, build output, lockfiles) so the stream isn't noisy.
        if (isWatchNoise(filename)) return;
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
        let closeWatch: ReturnType<typeof setInterval> | null = null;
        const finish = (): void => {
          if (closeWatch !== null) {
            clearInterval(closeWatch);
            closeWatch = null;
          }
          cleanup();
          resolveHold();
        };
        stream.onAbort(finish);
        // Defensive poll in case the stream closes without an abort event.
        closeWatch = setInterval(() => {
          if (stream.closed || stream.aborted) finish();
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
    // Hono already percent-decodes path params (an encoded "/" arrives as a
    // literal "/"), so we do NOT decode again — a second pass would corrupt a
    // filename or symbol containing a literal "%" (e.g. "a%20b.ts" → "a b.ts").
    const rawFile = c.req.param("filePath");
    const symbol = c.req.param("symbol");
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

  // ---- Mutation routes (slot 2; --writable gated, hono/csrf guarded) -------
  // Each parses { rootPath, ... }, validates rootPath containment, builds a
  // HandlerContext (actor "ui"), and maps the shared HandlerResult → HTTP.

  /** Map a handler envelope to an HTTP response (ok→200, else httpStatusFor). */
  const send = (c: Context, r: HandlerResult<unknown>): Response => {
    if (r.ok) return c.json({ ok: true, data: r.data });
    return c.json(
      { ok: false, code: r.code, message: r.message, retryable: r.retryable, data: r.data },
      httpStatusFor(r.code),
    );
  };

  /** Validate rootPath from a parsed body; returns ctx or an error response. */
  const ctxFromBody = async (
    c: Context,
    body: Record<string, unknown>,
  ): Promise<HandlerContext | Response> => {
    const root = await resolveRootPath(typeof body["rootPath"] === "string" ? body["rootPath"] : "");
    if (!root.ok) return c.json({ ok: false, code: root.code, message: root.error, retryable: false }, root.status);
    return { rootPath: root.rootPath, actor: "ui", writable };
  };

  const parseBody = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  // POST /api/blocks/autofix  { rootPath, filePath, diagnosticCode? }
  app.post("/api/blocks/autofix", async (c) => {
    const body = await parseBody(c);
    const ctx = await ctxFromBody(c, body);
    if (ctx instanceof Response) return ctx;
    const r = await applyAutofix(ctx, String(body["filePath"] ?? ""),
      typeof body["diagnosticCode"] === "string" ? body["diagnosticCode"] : undefined);
    if (r.ok) bump("block_autofixes_applied_total");
    return send(c, r);
  });

  // POST /api/blocks/edit  { rootPath, filePath, symbol, block, expectedMtimeMs? }
  app.post("/api/blocks/edit", async (c) => {
    const body = await parseBody(c);
    const ctx = await ctxFromBody(c, body);
    if (ctx instanceof Response) return ctx;
    const rawBlock = body["block"];
    if (
      typeof rawBlock !== "object" ||
      rawBlock === null ||
      typeof (rawBlock as Record<string, unknown>)["schema"] !== "number" ||
      typeof (rawBlock as Record<string, unknown>)["role"] !== "string" ||
      typeof (rawBlock as Record<string, unknown>)["responsibility"] !== "string"
    ) {
      return c.json(
        {
          ok: false,
          code: "SIVRU-E249",
          message: "invalid block shape: expected { schema: number, role: string, responsibility: string }",
          retryable: false,
        },
        400,
      );
    }
    const r = await editBlock(
      ctx,
      String(body["filePath"] ?? ""),
      String(body["symbol"] ?? ""),
      rawBlock as never,
      typeof body["expectedMtimeMs"] === "number" ? body["expectedMtimeMs"] : undefined,
    );
    if (r.ok) bump("block_edits_total");
    return send(c, r);
  });

  // POST /api/blocks/acknowledge  { rootPath, diagnostic: {code,filePath,symbolName}, note? }
  app.post("/api/blocks/acknowledge", async (c) => {
    const body = await parseBody(c);
    const ctx = await ctxFromBody(c, body);
    if (ctx instanceof Response) return ctx;
    const d = (body["diagnostic"] ?? {}) as Record<string, unknown>;
    const r = await acknowledgeDiagnostic(
      ctx,
      { code: String(d["code"] ?? ""), filePath: String(d["filePath"] ?? ""), symbolName: String(d["symbolName"] ?? "") },
      typeof body["note"] === "string" ? body["note"] : undefined,
    );
    if (r.ok) bump("acknowledgments_total");
    return send(c, r);
  });

  // POST /api/feedback  { rootPath, kind, diagnostic, label, note? }
  app.post("/api/feedback", async (c) => {
    const body = await parseBody(c);
    const ctx = await ctxFromBody(c, body);
    if (ctx instanceof Response) return ctx;
    const d = (body["diagnostic"] ?? {}) as Record<string, unknown>;
    const r = await appendFeedbackRecord(
      ctx,
      String(body["kind"] ?? "suggest") as FeedbackKind,
      { code: String(d["code"] ?? ""), filePath: String(d["filePath"] ?? ""), symbolName: String(d["symbolName"] ?? "") },
      String(body["label"] ?? ""),
      typeof body["note"] === "string" ? body["note"] : undefined,
    );
    if (r.ok) bump("feedback_records_total");
    return send(c, r);
  });

  // GET /api/feedback?rootPath=&kind=&code=  — NOT --writable-gated.
  app.get("/api/feedback", async (c) => {
    const root = await resolveRootPath(c.req.query("rootPath") ?? "");
    if (!root.ok) return c.json({ error: root.error, code: root.code }, root.status);
    const ctx: HandlerContext = { rootPath: root.rootPath, actor: "ui", writable };
    const kind = c.req.query("kind");
    const code = c.req.query("code");
    const r = await readFeedbackRecords(ctx, {
      ...(kind !== undefined ? { kind: kind as FeedbackKind } : {}),
      ...(code !== undefined ? { code } : {}),
    });
    return send(c, r);
  });
}
