// Shared progress reporter for `buildIndex` events. Used by
// `sivru bench personal` today (and a candidate to also replace the
// inlined writer in `sivru search`).
//
// Why this exists: a long-running build with no output looks hung. The
// silent gap is most painful between "chunked" (which fires fast) and
// the first "embed_progress" — that interval is the model download +
// ONNX init for transformer-based providers, which can be 10+ minutes
// on a fresh machine. We surface that as an explicit "still warming
// up" heartbeat.
//
// Two output modes: append-only (one line per event, default for
// non-TTY) and in-place (overwrite the same line via \r, default for
// TTY). On phase transitions in TTY mode we commit the previous line
// with a newline so it survives in scrollback.

import type { BuildIndexProgress } from "@sivru/search";

export type ProgressReporterOptions = {
  /** Pretty label prefixed on every line, e.g. the model's display name. */
  label?: string;
  /**
   * Approx cold-start (model download + ONNX warm-up) for THIS provider,
   * in minutes. Used in the "still preparing" heartbeat copy. Set to 0
   * (or omit) to skip the cold-start hint entirely.
   */
  coldStartMin?: number;
  /** When true, emit nothing. Used for `--json` mode. */
  silent?: boolean;
  /** Stream to write to. Default `process.stderr`. Tests inject a buffer. */
  out?: { write: (s: string) => boolean | void; isTTY?: boolean };
  /**
   * Force append-only / in-place. When undefined we look at `out.isTTY`.
   */
  inPlace?: boolean;
  /**
   * Override for the heartbeat interval. Default 30s. Tests pass a
   * smaller number paired with fake timers.
   */
  heartbeatMs?: number;
  /**
   * Throttle the embed_progress writes — don't print more often than
   * this. Default 250ms. Tests can pass 0 to disable throttling.
   */
  embedThrottleMs?: number;
};

export type ProgressReporter = {
  onEvent: (event: BuildIndexProgress) => void;
  /**
   * Stop the heartbeat timer and, in TTY mode, write a trailing newline
   * so the next caller's output starts on a fresh line. Idempotent.
   */
  finish: () => void;
};

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_EMBED_THROTTLE_MS = 250;

export function createProgressReporter(
  opts: ProgressReporterOptions = {},
): ProgressReporter {
  const out = opts.out ?? process.stderr;
  const silent = opts.silent ?? false;
  const inPlace = opts.inPlace ?? out.isTTY === true;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const embedThrottleMs = opts.embedThrottleMs ?? DEFAULT_EMBED_THROTTLE_MS;
  const prefix =
    opts.label !== undefined && opts.label !== "" ? `  ${opts.label}: ` : "  ";

  const start = Date.now();
  // Tracks only the last *embed_progress* write so the throttle window
  // doesn't accidentally suppress a "first embed after chunking" line
  // when both events fire within the same tick.
  let lastEmbedWriteMs = 0;
  let lastLine = "";
  let lastPhase: BuildIndexProgress["phase"] | null = null;
  let chunkedAtMs = 0;
  let firstEmbedSeen = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let finished = false;

  const writeLine = (line: string): void => {
    if (silent) return;
    if (inPlace) {
      // Carriage return + ANSI clear-to-end-of-line so leftover chars
      // from a longer previous line are wiped.
      out.write(`\r${line}\x1b[K`);
    } else {
      out.write(`${line}\n`);
    }
    lastLine = line;
  };

  const commitLine = (): void => {
    if (silent) return;
    if (inPlace && lastLine !== "") {
      out.write("\n");
      lastLine = "";
    }
  };

  const startHeartbeat = (): void => {
    if (silent || heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      if (firstEmbedSeen || finished) {
        stopHeartbeat();
        return;
      }
      const elapsedSec = Math.floor((Date.now() - chunkedAtMs) / 1000);
      const coldHint =
        opts.coldStartMin !== undefined && opts.coldStartMin > 0
          ? `, first call may take ~${opts.coldStartMin} min for download + warm-up`
          : "";
      writeLine(
        `${prefix}still preparing model (${formatDuration(elapsedSec)} since chunking${coldHint})…`,
      );
    }, heartbeatMs);
    // setInterval pins the process; mark it unref'd so a stuck heartbeat
    // can't keep Node alive after the user Ctrl+C's.
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const onEvent = (event: BuildIndexProgress): void => {
    if (silent || finished) return;
    const now = Date.now();
    let line = "";

    if (event.phase === "walked" && event.totalChunks !== undefined) {
      line = `${prefix}walked ${event.totalChunks} files`;
    } else if (event.phase === "chunked" && event.totalChunks !== undefined) {
      line = `${prefix}chunked ${event.totalChunks} chunks; embedding…`;
      chunkedAtMs = now;
      startHeartbeat();
    } else if (event.phase === "embed_progress") {
      const done = event.embedded ?? 0;
      const total = event.totalChunks ?? 0;
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      const elapsed = (now - start) / 1000;
      const rate = elapsed > 0 ? done / elapsed : 0;
      const etaSec =
        rate > 0 && total > done ? Math.ceil((total - done) / rate) : null;
      const etaPart =
        etaSec !== null ? ` · ETA ~${formatDuration(etaSec)}` : "";
      line = `${prefix}embedded ${done}/${total} (${pct}%, ${rate.toFixed(0)}/sec)${etaPart}`;
      firstEmbedSeen = true;
      stopHeartbeat();
    } else if (event.phase === "embed_done") {
      const total = event.totalChunks ?? 0;
      const elapsedSec = (now - start) / 1000;
      line = event.fromCache
        ? `${prefix}embeddings rehydrated from cache (${total} chunks)`
        : `${prefix}embedded ${total} chunks (${formatDuration(elapsedSec)})`;
      firstEmbedSeen = true;
      stopHeartbeat();
    } else if (event.phase === "cached") {
      line = `${prefix}loaded ${event.totalChunks ?? 0} chunks from cache`;
    }

    if (line === "") return;

    if (
      event.phase === "embed_progress" &&
      now - lastEmbedWriteMs < embedThrottleMs &&
      lastEmbedWriteMs > 0
    ) {
      return;
    }

    // Phase change in TTY mode: commit the previous line so it stays in
    // scrollback before we start overwriting on the next line.
    if (inPlace && lastPhase !== null && lastPhase !== event.phase) {
      commitLine();
    }

    if (line === lastLine) {
      if (event.phase === "embed_progress") lastEmbedWriteMs = now;
      return;
    }

    writeLine(line);
    if (event.phase === "embed_progress") lastEmbedWriteMs = now;
    lastPhase = event.phase;
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    stopHeartbeat();
    commitLine();
  };

  return { onEvent, finish };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
