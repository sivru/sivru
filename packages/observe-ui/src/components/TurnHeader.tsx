// Thin horizontal rule separating turns. Mono timestamp + tool icons
// summary + outcome dot — the visual hierarchy item per DESIGN.md §6.1.

import { memo, useCallback } from "react";
import type { Turn } from "../turns";
import {
  estimateTurnSavedTokens,
  formatBytesAsTokens,
  formatDuration,
  formatTokenCount,
  turnDurationMs,
} from "../turns";
import type { SessionSavings } from "../types";
import { formatTimestamp, truncate } from "../util";

const MAX_TOOLS_INLINE = 4;

type Props = {
  turn: Turn;
  /** Array index used as the toggle key — passed up via onToggle(turnArrayIndex). */
  turnArrayIndex: number;
  expanded: boolean;
  /**
   * Stable handler from App. Receives the array index of the turn whose
   * collapse state should flip. Stable identity means React.memo can skip
   * re-render of unchanged headers.
   */
  onToggle: (turnArrayIndex: number) => void;
  /** True when this is the most recent turn and the session is active. */
  isLatest: boolean;
  /**
   * Session-wide savings totals, when loaded. Used to compute and display
   * a per-turn savings estimate (proportional attribution by chunks
   * returned). Null while the savings request is in flight or unavailable.
   */
  sessionSavings: SessionSavings | null;
};

function outcomeDot(turn: Turn): { color: string; label: string } {
  if (turn.interrupted) return { color: "bg-sivru-warn", label: "interrupted" };
  if (turn.hasError) return { color: "bg-red-500", label: "errored" };
  return { color: "bg-emerald-500", label: "ok" };
}

function TurnHeaderInner({
  turn,
  turnArrayIndex,
  expanded,
  onToggle,
  isLatest,
  sessionSavings,
}: Props): JSX.Element {
  // Local handler bound to this row's array index — keeps the click target
  // stable across renders for React.memo's shallow equality.
  const handleClick = useCallback(() => {
    onToggle(turnArrayIndex);
  }, [onToggle, turnArrayIndex]);
  const dur = formatDuration(turnDurationMs(turn));
  const dot = outcomeDot(turn);
  const toolList = turn.tools.slice(0, MAX_TOOLS_INLINE);
  const moreCount = Math.max(0, turn.tools.length - toolList.length);
  const promptPreview =
    turn.prompt !== null && turn.prompt.trim().length > 0
      ? truncate(turn.prompt.replace(/\s+/g, " ").trim(), 80)
      : turn.index === 0
        ? "(pre-history events)"
        : "(no prompt)";

  // Per-turn saved-tokens estimate. null when the savings request hasn't
  // returned yet or there's no chunk data to attribute against — chip
  // falls back to showing search call/chunk counts in that case.
  const savedTokens = estimateTurnSavedTokens(
    turn,
    sessionSavings?.tokensSaved ?? null,
    sessionSavings?.chunksReturnedTotal ?? 0,
  );

  // Pre-compute the search chip's tooltip + suffix once. Two reasons:
  //  1. When savedTokens !== null, sessionSavings is provably non-null
  //     (estimateTurnSavedTokens returns null otherwise). Computing here
  //     lets us narrow the type via a guard instead of sprinkling
  //     `?? 0` fallbacks that can never fire.
  //  2. The trailing chunks-fallback collapses cleanly to "" (instead of
  //     the boolean `false` that JSX silently swallows but reads as a
  //     code smell).
  let searchTooltip: string;
  let searchSuffix: string;
  if (savedTokens !== null && sessionSavings !== null) {
    searchTooltip = `~${formatTokenCount(savedTokens)} tokens saved this turn (proportional attribution: ${turn.metrics.searchChunks} of ${sessionSavings.chunksReturnedTotal} chunks · ${sessionSavings.tokensSaved} tokens saved across the session)`;
    searchSuffix = ` · saved ~${formatTokenCount(savedTokens)} tok`;
  } else {
    searchTooltip = `sivru.search called ${turn.metrics.searchCalls}× this turn, returning ${turn.metrics.searchChunks} chunks total`;
    searchSuffix =
      turn.metrics.searchChunks > 0
        ? ` · ${turn.metrics.searchChunks} chunks`
        : "";
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-expanded={expanded}
      className={
        "group sticky -top-px z-[5] flex w-full items-center gap-3 border-y border-sivru-border bg-sivru-bg px-4 py-1.5 text-left text-[11px] " +
        "transition-colors hover:bg-sivru-panel/40"
      }
    >
      {/* Disclosure caret */}
      <span
        className={
          "shrink-0 select-none font-mono text-sivru-mute transition-transform " +
          (expanded ? "rotate-90" : "")
        }
        aria-hidden
      >
        ▸
      </span>

      <span className="font-mono text-sivru-mute">
        Turn {turn.index === 0 ? "0" : String(turn.index).padStart(2, " ")}
      </span>

      <span className="font-mono text-sivru-mute">·</span>

      <span className="font-mono text-sivru-mute">
        {formatTimestamp(turn.startedAt ?? undefined)}
      </span>

      {dur !== "" && (
        <>
          <span className="font-mono text-sivru-mute">·</span>
          <span className="font-mono text-sivru-mute">{dur}</span>
        </>
      )}

      {/* Per-turn coaching signal — the "is sivru helping here?" view.
          When sivru.search fired, prefer a saved-tokens number (real, via
          proportional attribution against the session-wide savings total)
          and fall back to call/chunk counts when savings haven't loaded.
          When no search fired AND the agent ingested heavy context (Read
          OR Bash output), show the missed-opportunity nudge.
          Hidden in the no-signal case so quiet turns stay visually quiet. */}
      {turn.metrics.searchCalls > 0 ? (
        <>
          <span className="font-mono text-sivru-mute">·</span>
          <span
            className="font-mono text-sivru-amber"
            title={searchTooltip}
          >
            ▸▸ search × {turn.metrics.searchCalls}
            {searchSuffix}
          </span>
        </>
      ) : turn.metrics.hasMissedOpportunity ? (
        <>
          <span className="font-mono text-sivru-mute">·</span>
          <span
            className="font-mono text-sivru-warn/90"
            title={`No sivru.search this turn — agent read ~${formatBytesAsTokens(turn.metrics.readBytes)} tokens of files + ~${formatBytesAsTokens(turn.metrics.bashOutputBytes)} tokens of shell output. A search call would likely have surfaced the right ranges in <2k tokens.`}
          >
            ⚠ no search · ~{formatBytesAsTokens(turn.metrics.readBytes + turn.metrics.bashOutputBytes)} ingested
          </span>
        </>
      ) : null}

      {toolList.length > 0 && (
        <>
          <span className="font-mono text-sivru-mute">·</span>
          <span className="flex flex-wrap items-center gap-1 text-sivru-mute">
            {toolList.map((t, i) => (
              <span
                key={t + i}
                className="inline-block rounded border border-sivru-border bg-sivru-panel/60 px-1 py-px font-mono text-[10px]"
              >
                {t}
              </span>
            ))}
            {moreCount > 0 && (
              <span className="font-mono text-[10px]">+{moreCount}</span>
            )}
          </span>
        </>
      )}

      <span className="ml-auto flex items-center gap-2">
        {isLatest && (
          <span className="flex items-center gap-1.5 text-sivru-amber" title="latest turn">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-sivru-amber opacity-50"></span>
              <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-sivru-amber"></span>
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider">latest</span>
          </span>
        )}

        <span
          className={"inline-block h-2 w-2 rounded-full " + dot.color}
          title={dot.label}
          aria-label={dot.label}
        />

        <span className="hidden truncate text-sivru-mute md:inline" style={{ maxWidth: 320 }}>
          {promptPreview}
        </span>

        <span className="font-mono text-[10px] text-sivru-mute">
          {turn.events.length} ev
        </span>
      </span>
    </button>
  );
}

// Memoize the row, but with a CUSTOM equality function: computeTurns
// produces fresh Turn objects on every call (including for turns that
// didn't change), so the default shallow compare on `turn` would fail
// for every header on every batch flush. We compare the fields that
// actually drive the rendered output. For a 50-turn session where only
// the latest turn picks up a new event in this batch, this skips 49 of
// 50 header re-renders.
export const TurnHeader = memo(TurnHeaderInner, (prev, next) => {
  if (prev.expanded !== next.expanded) return false;
  if (prev.isLatest !== next.isLatest) return false;
  if (prev.onToggle !== next.onToggle) return false;
  if (prev.turnArrayIndex !== next.turnArrayIndex) return false;
  if (prev.sessionSavings !== next.sessionSavings) return false;
  const a = prev.turn;
  const b = next.turn;
  if (a.index !== b.index) return false;
  if (a.events.length !== b.events.length) return false;
  if (a.startedAt !== b.startedAt) return false;
  if (a.endedAt !== b.endedAt) return false;
  if (a.hasError !== b.hasError) return false;
  if (a.interrupted !== b.interrupted) return false;
  if (a.usedSivruSearch !== b.usedSivruSearch) return false;
  if (a.tools.length !== b.tools.length) return false;
  // Tools array is an Array.from() of a Set — order is stable, so
  // length-equal + first-elem-equal is a cheap proxy for "no change".
  if (a.tools[0] !== b.tools[0]) return false;
  const m1 = a.metrics;
  const m2 = b.metrics;
  return (
    m1.searchCalls === m2.searchCalls &&
    m1.searchChunks === m2.searchChunks &&
    m1.readBytes === m2.readBytes &&
    m1.bashOutputBytes === m2.bashOutputBytes &&
    m1.hasMissedOpportunity === m2.hasMissedOpportunity
  );
});
