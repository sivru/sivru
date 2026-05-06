// W6 — Hono app factory for the @sivrujs/observe HTTP server.
// See DESIGN.md §5 (observe architecture) and §5.5 (privacy boundary).
//
// PRIVACY NOTE (DESIGN.md §5.5): this file is part of the inbound listener
// surface. It builds an in-process request handler — no outbound calls. The
// underlying server (server/index.ts) binds to localhost only.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  createReadStream,
  existsSync,
  readdirSync,
  unwatchFile,
  watchFile,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

import type { SessionSource } from "../sources/adapter.js";
import {
  createJsonlSource,
  parseJsonlLine,
  sessionIdFromPath,
} from "../sources/jsonl/index.js";
import type { JsonlSourceOptions } from "../sources/jsonl/index.js";
import type { SivruEvent } from "../types.js";
import { estimateSavings } from "../cost/savings.js";
import { aggregateReplay, replaySession } from "../replay/index.js";

// The version constant lives in the package barrel; re-declare it here to
// avoid a cycle (../index.js re-exports server/app). Keep in sync.
const SIVRU_OBSERVE_VERSION = "0.1.0";

export type ObserveAppOptions = {
  /**
   * Override the session source. Default: `createJsonlSource()` (reads
   * `~/.claude/projects/`). Tests inject a sandboxed source.
   */
  source?: SessionSource;
  /** Forwarded to the default jsonl source if `source` isn't supplied. */
  jsonlOptions?: JsonlSourceOptions;
  /**
   * Optional path to a built static UI directory (e.g. observe-ui's `dist/`).
   * When set, `GET /` and any non-API path serves the UI. Path traversal
   * outside this dir is rejected.
   */
  uiDistDir?: string;
};

const DEFAULT_EVENT_LIMIT = 1000;

/**
 * Allow only `http://localhost:*` and `http://127.0.0.1:*` origins.
 * The W6 ui agent runs Vite on localhost; production deployments don't apply.
 * Returns the origin if allowed, otherwise null so hono/cors does NOT echo it
 * into Access-Control-Allow-Origin.
 */
function isLocalhostOrigin(origin: string): boolean {
  // Accept e.g. http://localhost:5173, http://127.0.0.1:5173 (any port, none too).
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** Build the Hono app. Pure: no port binding. Tests call `app.fetch(...)` directly. */
export function createObserveApp(options?: ObserveAppOptions): Hono {
  const source: SessionSource =
    options?.source ?? createJsonlSource(options?.jsonlOptions);

  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (isLocalhostOrigin(origin) ? origin : null),
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/api/health", (c) =>
    c.json({ ok: true, version: SIVRU_OBSERVE_VERSION }),
  );

  app.get("/api/sessions", async (c) => {
    const sessions = await source.listSessions();
    return c.json({ sessions });
  });

  app.get("/api/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const limitParam = c.req.query("limit");
    const limit = parseLimit(limitParam);

    const sessions = await source.listSessions();
    const match = sessions.find((s) => s.id === id);
    if (match === undefined) {
      return c.json({ error: "not found" }, 404);
    }

    // Read all events into a ring buffer of size `limit` so we keep the most
    // recent N (older events first within the returned window). For typical
    // session sizes the buffer is small (default 1000); the underlying source
    // streams lazily from disk.
    const buffer: SivruEvent[] = [];
    for await (const event of source.readSession(match.path)) {
      buffer.push(event);
      if (buffer.length > limit) buffer.shift();
    }

    return c.json({ sessionId: id, events: buffer });
  });

  // Live-tail SSE: replay existing events then watch for appends. The
  // client opens this with EventSource (`subscribeToEvents` in observe-ui).
  // We track byte offset + event index ourselves so reconnects keep the
  // monotonically-increasing index space the jsonl reader would have
  // produced. File-rotation safe (truncate -> reset offset and re-read).
  app.get("/api/sessions/:id/stream", async (c) => {
    const id = c.req.param("id");
    const sessions = await source.listSessions();
    const match = sessions.find((s) => s.id === id);
    if (match === undefined) {
      return c.json({ error: "not found" }, 404);
    }
    const filePath = match.path;
    const fallbackSessionId = sessionIdFromPath(filePath);

    return streamSSE(c, async (stream) => {
      // Per-connection mutable state. Closures below capture these.
      let byteOffset = 0;
      let eventIndex = 0;
      // Buffered partial line — bytes after the last `\n` that we've read but
      // haven't yet seen terminated. We hold it across reads so a write
      // that splits a line mid-record is reassembled correctly.
      let pendingLine = "";
      let watching = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const writeEvent = async (ev: SivruEvent): Promise<void> => {
        await stream.writeSSE({ event: "event", data: JSON.stringify(ev) });
      };

      // Read [byteOffset, fileSize) from disk and emit any complete lines as
      // SivruEvents. Mutates byteOffset, eventIndex, and pendingLine.
      const readNewBytes = async (fileSize: number): Promise<void> => {
        if (fileSize <= byteOffset) return;
        await new Promise<void>((resolvePromise, reject) => {
          const rs = createReadStream(filePath, {
            encoding: "utf8",
            start: byteOffset,
            end: fileSize - 1, // inclusive
          });
          rs.on("data", (chunk) => {
            // utf8 encoding => chunk is string
            pendingLine += chunk as string;
            // Drain complete lines.
            let nl = pendingLine.indexOf("\n");
            while (nl !== -1) {
              const line = pendingLine.slice(0, nl);
              pendingLine = pendingLine.slice(nl + 1);
              const { events, nextIndex } = parseJsonlLine(
                // Strip a trailing CR if the file uses CRLF.
                line.endsWith("\r") ? line.slice(0, -1) : line,
                fallbackSessionId,
                eventIndex,
              );
              eventIndex = nextIndex;
              for (const ev of events) {
                // Fire and forget — errors propagate through stream.
                void writeEvent(ev);
              }
              nl = pendingLine.indexOf("\n");
            }
          });
          rs.on("end", () => {
            byteOffset = fileSize;
            resolvePromise();
          });
          rs.on("error", (err) => reject(err));
        });
      };

      const cleanup = (): void => {
        if (watching) {
          unwatchFile(filePath, onChange);
          watching = false;
        }
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      // watchFile listener: fires on poll when stat changes. We compare sizes
      // to detect appends vs rotation/truncation. Errors are swallowed so a
      // transient stat hiccup doesn't kill the stream.
      function onChange(curr: { size: number }, prev: { size: number }): void {
        // File deleted/replaced or truncated: reset and re-read from 0.
        if (curr.size < prev.size || curr.size < byteOffset) {
          byteOffset = 0;
          eventIndex = 0;
          pendingLine = "";
        }
        if (curr.size > byteOffset) {
          void readNewBytes(curr.size).catch(() => {
            // Swallow — best-effort live tail. The next poll will retry.
          });
        }
      }

      // Tear everything down when the client disconnects. `onAbort` is the
      // hono streaming hook; the AbortSignal on the raw request is also
      // wired via the StreamingApi internals.
      stream.onAbort(() => {
        cleanup();
      });

      // 1. Initial backfill — read whatever exists right now.
      let initialSize = 0;
      try {
        const st = await stat(filePath);
        initialSize = st.size;
      } catch {
        initialSize = 0;
      }
      try {
        await readNewBytes(initialSize);
      } catch {
        // ignore — we'll still keep the stream open in case the file appears.
      }

      // 2. Start polling. fs.watchFile is more reliable than fs.watch on
      // macOS, especially for editor-style atomic replaces. 250ms keeps it
      // snappy without burning CPU.
      watchFile(filePath, { interval: 250 }, onChange);
      watching = true;

      // 3. Heartbeat every 15s. SSE comments (`: ...`) are ignored by
      // EventSource clients but keep proxies / browsers from idle-closing.
      heartbeatTimer = setInterval(() => {
        if (stream.closed || stream.aborted) return;
        // Direct write so we don't go through writeSSE (which would emit a
        // data: line); plain comment frame is enough.
        void stream.write(": ping\n\n").catch(() => {
          // If write fails, the stream is gone — let onAbort handle teardown.
        });
      }, 15_000);

      // 4. Hold the handler open until aborted. We poll a closed flag rather
      // than awaiting a single Promise so the heartbeat + watchFile callbacks
      // continue to run.
      await new Promise<void>((resolveHold) => {
        const finish = (): void => {
          cleanup();
          resolveHold();
        };
        stream.onAbort(finish);
        // Defensive: if the stream gets closed by something other than abort
        // (e.g. an upstream error), poll for it.
        const closeWatch = setInterval(() => {
          if (stream.closed || stream.aborted) {
            clearInterval(closeWatch);
            finish();
          }
        }, 1000);
      });
    });
  });

  // Per-session savings estimate — drives the UI footer and the
  // zero-search nudge logic. Re-streams events through estimateSavings.
  app.get("/api/sessions/:id/savings", async (c) => {
    const id = c.req.param("id");
    const sessions = await source.listSessions();
    const match = sessions.find((s) => s.id === id);
    if (match === undefined) {
      return c.json({ error: "not found" }, 404);
    }
    const summary = await estimateSavings(source.readSession(match.path));
    return c.json({ sessionId: id, ...summary });
  });

  // Per-session counterfactual replay — drives the UI replay-diff view
  // (DESIGN.md §6.5). Walks every event and returns the per-event
  // actual/counterfactual token deltas plus the totals scoreboard. CLI
  // `sivru observe replay <id>` uses the same `replaySession` function;
  // the HTTP path just exposes its output for the browser.
  app.get("/api/sessions/:id/replay", async (c) => {
    const id = c.req.param("id");
    const sessions = await source.listSessions();
    const match = sessions.find((s) => s.id === id);
    if (match === undefined) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await replaySession(source.readSession(match.path));
    return c.json({ sessionId: id, ...result });
  });

  // Aggregate rollup across many sessions — drives the "since=N days"
  // dashboard view. Optional `since` query param: number of days back.
  app.get("/api/savings", async (c) => {
    const sinceParam = c.req.query("since");
    const sinceDays = sinceParam !== undefined ? Number.parseInt(sinceParam, 10) : null;
    const cutoff =
      sinceDays !== null && Number.isFinite(sinceDays) && sinceDays > 0
        ? Date.now() - sinceDays * 86_400_000
        : null;

    const sessions = await source.listSessions();
    const filtered = sessions.filter((s) => {
      if (cutoff === null) return true;
      if (s.updatedAt === null) return false;
      return Date.parse(s.updatedAt) >= cutoff;
    });

    const report = await aggregateReplay(
      filtered.map((s) => ({ id: s.id, events: source.readSession(s.path) })),
    );
    return c.json({ ...report, sessionsCount: filtered.length });
  });

  // Bench history — list and read past `sivru bench personal` runs.
  // The CLI writes JSON files to `~/.cache/sivru/bench-history/<ts>.json`
  // (see packages/cli/src/lib/bench-history.ts). We don't import the CLI
  // here — would create a backwards dependency — so the schema check is
  // inlined: anything with formatVersion === 1 and a `repos` array is
  // returned as-is. Older / forward-incompatible files surface as 404.
  app.get("/api/bench-history", (c) => {
    const dir = join(homedir(), ".cache", "sivru", "bench-history");
    if (!existsSync(dir)) return c.json({ runs: [] });
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return c.json({ runs: [] });
    }
    files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const runs = files.map((f) => ({
      id: f.replace(/\.json$/, ""),
      // The on-disk filename uses `-` for `:` (NTFS safety). Reverse
      // for display so the UI sees a real ISO timestamp.
      startedAt: f
        .replace(/\.json$/, "")
        .replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3"),
    }));
    return c.json({ runs });
  });

  app.get("/api/bench-history/:id", async (c) => {
    const id = c.req.param("id");
    // Reject any path-shaped id — directory traversal guard.
    if (id.includes("/") || id.includes("\\") || id.includes("..")) {
      return c.json({ error: "invalid id" }, 400);
    }
    const dir = join(homedir(), ".cache", "sivru", "bench-history");
    const path = join(dir, `${id}.json`);
    if (!existsSync(path)) return c.json({ error: "not found" }, 404);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { formatVersion?: number };
      if (parsed.formatVersion !== 1) {
        return c.json({ error: "incompatible format version" }, 410);
      }
      return c.json(parsed);
    } catch (err) {
      return c.json(
        { error: "could not read run", detail: (err as Error).message },
        500,
      );
    }
  });

  // Static UI mount — served only when `uiDistDir` is supplied. Hono's
  // `notFound` runs after all explicit routes miss, so `/api/...` is reached
  // first; everything else falls through to the static handler. SPA-style:
  // unknown paths fall back to `index.html` so client-side routing works.
  if (options?.uiDistDir !== undefined) {
    const root = resolve(options.uiDistDir);
    app.notFound(async (c) => {
      const reqPath = new URL(c.req.url).pathname;
      // Don't fall through to the SPA for unmatched API paths — keep the
      // 404 explicit so clients get a clear signal.
      if (reqPath.startsWith("/api/")) {
        return c.json({ error: "not found" }, 404);
      }
      const relPath = reqPath === "/" ? "/index.html" : reqPath;
      const safePath = normalize(join(root, relPath));
      if (!safePath.startsWith(root + sep) && safePath !== root) {
        return c.text("not found", 404);
      }
      const file = existsSync(safePath) ? safePath : join(root, "index.html");
      try {
        const buf = await readFile(file);
        return new Response(new Uint8Array(buf), {
          status: 200,
          headers: { "content-type": mimeType(file) },
        });
      } catch {
        return c.text("not found", 404);
      }
    });
  }

  return app;
}

function mimeType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":   return "application/javascript; charset=utf-8";
    case ".mjs":  return "application/javascript; charset=utf-8";
    case ".css":  return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg":  return "image/svg+xml";
    case ".png":  return "image/png";
    case ".jpg":  return "image/jpeg";
    case ".jpeg": return "image/jpeg";
    case ".woff": return "font/woff";
    case ".woff2":return "font/woff2";
    default:      return "application/octet-stream";
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_EVENT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EVENT_LIMIT;
  return n;
}
