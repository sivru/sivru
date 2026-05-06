// Group a flat event stream into turns (DESIGN.md §6.1).
//
// A "turn" begins on a `user_message` and includes every event up to (but
// not including) the next `user_message`. Sessions that don't start with a
// user_message — typical for pre-existing checkpoints — get a synthetic
// turn 0 holding everything until the first user_message arrives.
//
// `system` events are tracked but rendered subordinately by the timeline;
// they exist mostly for hooks/subagents and shouldn't compete visually
// with the turn's actual work.

import type { SivruEvent } from "./types";
import { getResultCount, parseSearchOutput } from "./sivru-search";
import { isSivruSearchTool } from "./util";

/** Heuristic threshold for "the agent ingested heavy context this turn".
 *  When the sum of Read content bytes + Bash output bytes is over this
 *  threshold AND no sivru.search call fired, we flag it as a missed
 *  opportunity. Bash counts because `Bash grep -r ...` is the canonical
 *  fallback the agent reaches for when sivru isn't wired up — DESIGN.md
 *  §20.1 / the project-goal coaching memory. */
const MISSED_OPPORTUNITY_HEAVY_CONTEXT_BYTES = 5_000;

/** Per-turn signal for the "is the engineer using sivru well?" coaching
 *  story. All numbers are derived client-side from the event stream —
 *  no extra server round-trip. */
export type TurnMetrics = {
  /** Count of sivru.search tool_use events in the turn. */
  searchCalls: number;
  /** Sum of result counts across those searches (as parsed from tool_result). */
  searchChunks: number;
  /** Bytes returned by Read tool_results (i.e. how much raw file content the
   *  agent pulled into context). */
  readBytes: number;
  /** Bytes returned by Bash tool_results — separate so we can show
   *  "47k tokens read · 12k tokens shell output" if useful. */
  bashOutputBytes: number;
  /**
   * True when the agent read substantial content this turn but never called
   * sivru.search. The classic missed-opportunity signal: drives the per-turn
   * "▸▸ no search" coaching badge.
   */
  hasMissedOpportunity: boolean;
};

export type Turn = {
  /** 1-based turn number. Synthetic pre-history turn is 0. */
  index: number;
  /** Event indices included in this turn (in chronological order). */
  eventIndices: number[];
  /** Convenience refs back into the event array. */
  events: SivruEvent[];
  /** Iso timestamp of the first event in the turn (or null). */
  startedAt: string | null;
  /** Iso timestamp of the last event (or null). */
  endedAt: string | null;
  /** Did any event in the turn carry isError=true? */
  hasError: boolean;
  /** Did the turn end with an unmatched tool_use (interrupted)? */
  interrupted: boolean;
  /** Distinct tool names invoked during the turn. */
  tools: string[];
  /** Did this turn invoke sivru.search? */
  usedSivruSearch: boolean;
  /** First user_message text, if any (used as turn title). */
  prompt: string | null;
  /** Per-turn coaching metrics — the "is sivru helping here?" signal. */
  metrics: TurnMetrics;
};

/** Bytes contained in a tool_result's output payload. Handles plain
 *  strings, JSON-stringified content, and the MCP `{content:[{text}]}`
 *  envelope. We don't try to be precise — this is a cost-of-context proxy. */
function toolResultBytes(output: unknown): number {
  if (output === null || output === undefined) return 0;
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) {
    let total = 0;
    for (const block of output) {
      if (typeof block === "string") total += block.length;
      else if (block !== null && typeof block === "object") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") total += text.length;
      }
    }
    return total;
  }
  if (typeof output === "object") {
    try {
      return JSON.stringify(output).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function computeTurns(events: readonly SivruEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let tools = new Set<string>();
  let pendingToolUses = new Set<number>(); // tool_use indices awaiting result
  let metrics: TurnMetrics = freshMetrics();
  // O(1) tracker for "what was the last tool_use this turn?" — replaces
  // the previous O(N) lookback through `events[]`. Reset on each new turn.
  // Sufficient because Claude Code dispatches tool calls sequentially: any
  // tool_result attaches to the most recently issued tool_use that hasn't
  // been paired off yet.
  let lastToolUseInTurn: string | null = null;

  const startTurn = (prompt: string | null, ts: string | null): Turn => {
    tools = new Set<string>();
    pendingToolUses = new Set<number>();
    metrics = freshMetrics();
    lastToolUseInTurn = null;
    const t: Turn = {
      index: turns.length === 0 ? (prompt === null ? 0 : 1) : turns.length + 1,
      eventIndices: [],
      events: [],
      startedAt: ts,
      endedAt: ts,
      hasError: false,
      interrupted: false,
      tools: [],
      usedSivruSearch: false,
      prompt,
      metrics: freshMetrics(),
    };
    return t;
  };

  const pushTo = (turn: Turn, e: SivruEvent): void => {
    turn.eventIndices.push(e.index);
    turn.events.push(e);
    turn.endedAt = e.ts ?? turn.endedAt;
    if (e.isError === true) turn.hasError = true;
    if (e.kind === "tool_use") {
      pendingToolUses.add(e.index);
      if (e.tool !== undefined && e.tool !== null) {
        tools.add(e.tool);
        lastToolUseInTurn = e.tool;
        if (isSivruSearchTool(e.tool)) {
          turn.usedSivruSearch = true;
          metrics.searchCalls += 1;
        }
      }
    } else if (e.kind === "tool_result") {
      let largest = -1;
      for (const idx of pendingToolUses) if (idx > largest) largest = idx;
      if (largest !== -1) pendingToolUses.delete(largest);

      const toolName = e.tool ?? lastToolUseInTurn;
      const bytes = toolResultBytes(e.output);
      if (toolName !== null && isSivruSearchTool(toolName)) {
        const count = getResultCount(e.output);
        if (count !== null) metrics.searchChunks += count;
        else {
          // Fallback: try to count hits via the parsed envelope.
          const parsed = parseSearchOutput(e.output);
          if (parsed !== null) {
            metrics.searchChunks +=
              parsed.results?.length ?? parsed.hits?.length ?? 0;
          }
        }
      } else if (toolName === "Read") {
        metrics.readBytes += bytes;
      } else if (toolName === "Bash") {
        metrics.bashOutputBytes += bytes;
      }
    }
  };

  const finalize = (turn: Turn): Turn => {
    turn.tools = Array.from(tools);
    turn.interrupted = pendingToolUses.size > 0;
    // Heavy-context bytes = file reads + bash output (both are tokens the
    // agent ingested into context). Spec called for "big Reads OR Bash
    // grep" to trigger the missed-opportunity badge — early implementation
    // missed the Bash half. Fixed.
    const heavyContextBytes = metrics.readBytes + metrics.bashOutputBytes;
    turn.metrics = {
      ...metrics,
      hasMissedOpportunity:
        metrics.searchCalls === 0 &&
        heavyContextBytes >= MISSED_OPPORTUNITY_HEAVY_CONTEXT_BYTES,
    };
    return turn;
  };

  for (const e of events) {
    if (e.kind === "user_message") {
      if (current !== null) {
        turns.push(finalize(current));
      }
      current = startTurn(e.text ?? null, e.ts ?? null);
      pushTo(current, e);
      continue;
    }
    if (current === null) {
      current = startTurn(null, e.ts ?? null);
    }
    pushTo(current, e);
  }

  if (current !== null) {
    turns.push(finalize(current));
  }

  return turns;
}

/**
 * Decide which turns should render expanded. Live session: latest only.
 * Ended session: latest only. Older turns are always collapsed by default,
 * the user can click the header to expand any of them.
 */
export function defaultExpansion(turns: readonly Turn[]): Set<number> {
  const out = new Set<number>();
  if (turns.length === 0) return out;
  out.add(turns.length - 1);
  return out;
}

/** Format duration like `2m 18s` / `840ms` / `47s`. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function freshMetrics(): TurnMetrics {
  return {
    searchCalls: 0,
    searchChunks: 0,
    readBytes: 0,
    bashOutputBytes: 0,
    hasMissedOpportunity: false,
  };
}

/** Render a raw token count as a tight badge: "12.4k", "847", etc. */
export function formatTokenCount(tokens: number): string {
  const t = Math.round(tokens);
  if (t >= 10_000) return `${(t / 1000).toFixed(0)}k`;
  if (t >= 1_000) return `${(t / 1000).toFixed(1)}k`;
  return String(t);
}

/** Render bytes as a tight token-count badge: "12.4k", "847", etc.
 *  ~4 chars/token is the conventional API-billing approximation. */
export function formatBytesAsTokens(bytes: number): string {
  return formatTokenCount(bytes / 4);
}

/**
 * Per-turn saved-tokens estimate via proportional attribution against the
 * session-wide savings number. The savings estimator returns
 * `tokensSaved` and `chunksReturnedTotal` for the whole session — we
 * apportion that by this turn's share of returned chunks. Returns null
 * when there's no signal (savings not loaded, no chunks anywhere, or
 * this turn returned no chunks).
 *
 * Tradeoff: this is an attribution, not a measurement. A turn that
 * returned 5 chunks gets credited with 5/N of the total savings, even
 * though some of those chunks may have been less useful than others.
 * Better than no number; worse than a per-turn savings figure that
 * the server could compute with full chunk-level accounting. Tracked
 * for v0.2: extend the savings estimator to bucket savings per turn
 * directly, then drop this approximation.
 */
export function estimateTurnSavedTokens(
  turn: Turn,
  sessionTokensSaved: number | null,
  sessionChunksReturnedTotal: number,
): number | null {
  if (sessionTokensSaved === null || sessionTokensSaved <= 0) return null;
  if (sessionChunksReturnedTotal <= 0) return null;
  if (turn.metrics.searchChunks <= 0) return null;
  // Clamp the share to 1.0. Client and server can disagree on chunk counts
  // (different envelope parsers, partial parse failures, MCP shape drift) —
  // without the clamp, a turn whose locally-counted chunks exceed the
  // server's reported total could be attributed *more than* the entire
  // session's savings, producing visibly wrong "saved 2× total" numbers.
  const share = Math.min(
    1,
    turn.metrics.searchChunks / sessionChunksReturnedTotal,
  );
  return Math.round(sessionTokensSaved * share);
}

/** Compact turn duration in milliseconds. */
export function turnDurationMs(turn: Turn): number | null {
  if (turn.startedAt === null || turn.endedAt === null) return null;
  const a = new Date(turn.startedAt).getTime();
  const b = new Date(turn.endedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return b - a;
}
