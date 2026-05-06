// Per-kind styled event row inside a turn. DESIGN.md §6.1 visual hierarchy:
//
//   sivru.search tool_use     soft-amber, BOLD, with `▸▸` prefix and
//                             a results badge — the loudest thing in
//                             the timeline. This is the value-prop event.
//   user_message              italic, indented, leading curly quote —
//                             "fix the auth flow bug"
//   assistant_message         regular text, no bullet
//   tool_use (other)          dim zinc, bullet-prefixed (`• Read foo.ts`)
//   tool_result               inline-coupled with the parent tool_use
//                             when it isn't an error; standalone red row
//                             when isError === true
//   system / unknown          tiny, dim, monospace (rarely useful)

import { forwardRef, memo, useCallback } from "react";
import type { SivruEvent } from "../types";
import { formatTimestamp, truncate, isSivruSearchTool } from "../util";
import {
  describeSearchInput,
  getLatencyMs,
  getResultCount,
} from "../sivru-search";
import type { SearchProvenance } from "../search-provenance";

type Props = {
  event: SivruEvent;
  selected: boolean;
  /**
   * The sivru.search call that surfaced this event's target file, if any.
   * Set on Read / Edit / MultiEdit / Write rows — the proof that sivru
   * was useful, not just called.
   */
  fromSearch?: SearchProvenance | null;
  /**
   * For sivru.search tool_use events: how many subsequent events
   * consumed at least one of the returned chunks. Drives the
   * "→ used by N" badge on search rows.
   */
  consumerCount?: number;
  /**
   * Stable handler from App — receives the toggle decision (this row's
   * index when un-selecting from selected, null when toggling off the
   * already-selected row). The toggle math lives here in TimelineEvent
   * so the parent can pass a memo-stable function reference.
   */
  onSelect: (index: number | null) => void;
};

function summarizeOutput(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

const TimelineEventInner = forwardRef<HTMLButtonElement, Props>(
  (
    { event, selected, fromSearch = null, consumerCount = 0, onSelect },
    ref,
  ) => {
    // Local toggle binding — depends on `selected` and `event.index`, both
    // primitive props, so React.memo's shallow equality picks it up.
    const onClick = useCallback(() => {
      onSelect(selected ? null : event.index);
    }, [onSelect, selected, event.index]);
    const ts = formatTimestamp(event.ts);

    const baseClasses =
      "group flex w-full items-start gap-3 border-l-2 px-4 py-1 text-left transition-colors";
    const selectedRing = selected
      ? "border-sivru-amber bg-sivru-amber/10"
      : "border-transparent hover:bg-sivru-panel/40";

    // ---- sivru.search tool_use — the marquee event ---------------------
    if (event.kind === "tool_use" && isSivruSearchTool(event.tool)) {
      const summary = describeSearchInput(event.input) ?? "(unparsed input)";
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          className={baseClasses + " " + selectedRing}
        >
          <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
            {ts}
          </span>
          <span className="font-mono text-[12px] font-bold text-sivru-amber">
            ▸▸ sivru.search
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-sivru-text">
            {summary}
          </span>
          {consumerCount > 0 && (
            <span
              className="shrink-0 rounded border border-sivru-amber/40 bg-sivru-amber/10 px-1.5 py-px font-mono text-[10px] text-sivru-amber"
              title={`${consumerCount} downstream event${consumerCount === 1 ? "" : "s"} touched a file from this search — proof the result was useful`}
            >
              → used by {consumerCount}
            </span>
          )}
        </button>
      );
    }

    // ---- sivru.search tool_result — attach the result count ------------
    if (event.kind === "tool_result" && isSivruSearchTool(event.tool)) {
      const count = getResultCount(event.output);
      const latency = getLatencyMs(event.output);
      const fragments: string[] = [];
      fragments.push(count === null ? "results" : `${count} result${count === 1 ? "" : "s"}`);
      if (latency !== null) fragments.push(`${latency.toFixed(1)} ms`);
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          className={baseClasses + " " + selectedRing}
        >
          <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
            {ts}
          </span>
          <span className="font-mono text-[11px] text-sivru-amber/80">→</span>
          <span className="font-mono text-[11px] text-sivru-amber">
            {fragments.join(" · ")}
          </span>
          {event.isError === true && (
            <span className="font-mono text-[11px] text-red-400">[error]</span>
          )}
        </button>
      );
    }

    // ---- user_message — italic-quoted ----------------------------------
    if (event.kind === "user_message") {
      const text = (event.text ?? "").trim();
      const preview = truncate(text.replace(/\s+/g, " "), 200);
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          className={baseClasses + " " + selectedRing}
        >
          <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
            {ts}
          </span>
          <span className="select-none font-mono text-[11px] text-sivru-mute">❝</span>
          <span className="min-w-0 flex-1 italic text-sivru-text">{preview}</span>
        </button>
      );
    }

    // ---- assistant_message — plain text --------------------------------
    if (event.kind === "assistant_message") {
      const text = (event.text ?? "").trim();
      const preview = truncate(text.replace(/\s+/g, " "), 200);
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          className={baseClasses + " " + selectedRing}
        >
          <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
            {ts}
          </span>
          <span className="min-w-0 flex-1 text-[12px] text-sivru-text">
            {preview.length === 0 ? (
              <span className="italic text-sivru-mute">(no content)</span>
            ) : (
              preview
            )}
          </span>
        </button>
      );
    }

    // ---- generic tool_use — dim, bullet-prefixed ------------------------
    if (event.kind === "tool_use") {
      const arg = summarizeOutput(event.input);
      const preview = truncate(arg.replace(/\s+/g, " "), 100);
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          className={baseClasses + " " + selectedRing}
        >
          <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
            {ts}
          </span>
          <span className="select-none font-mono text-[11px] text-sivru-mute">•</span>
          <span className="font-mono text-[12px] text-sivru-text">
            {event.tool ?? "(tool)"}
          </span>
          {preview.length > 0 && (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-sivru-mute">
              {preview}
            </span>
          )}
          {fromSearch !== null && (
            <span
              className="shrink-0 rounded border border-sivru-amber/40 bg-sivru-amber/10 px-1.5 py-px font-mono text-[10px] text-sivru-amber"
              title={`Recommended by sivru.search at event ${fromSearch.searchEventIndex}${fromSearch.startLine !== undefined ? ` (range ${fromSearch.startLine}-${fromSearch.endLine})` : ""}`}
            >
              ↑ from search
            </span>
          )}
        </button>
      );
    }

    // ---- generic tool_result — only show when error or standalone ------
    if (event.kind === "tool_result") {
      if (event.isError !== true) {
        // Non-error results are visually folded into the parent tool_use.
        // Render as a tiny dim row so the user can still inspect it but it
        // doesn't compete for attention.
        return (
          <button
            ref={ref}
            type="button"
            onClick={onClick}
            className={baseClasses + " " + selectedRing + " opacity-60"}
          >
            <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
              {ts}
            </span>
            <span className="select-none font-mono text-[11px] text-sivru-mute">↳</span>
            <span className="font-mono text-[11px] text-sivru-mute">result</span>
          </button>
        );
      }
      const out = summarizeOutput(event.output);
      return (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          className={baseClasses + " " + selectedRing}
        >
          <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
            {ts}
          </span>
          <span className="select-none font-mono text-[11px] text-red-400">↳</span>
          <span className="font-mono text-[12px] text-red-400">error</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-red-400/80">
            {truncate(out.replace(/\s+/g, " "), 120)}
          </span>
        </button>
      );
    }

    // ---- system / unknown — tiny ----------------------------------------
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={baseClasses + " " + selectedRing + " opacity-50"}
      >
        <span className="w-12 shrink-0 font-mono text-[11px] text-sivru-mute">
          {ts}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-sivru-mute">
          {event.kind}
        </span>
      </button>
    );
  },
);
TimelineEventInner.displayName = "TimelineEvent";

// Custom equality: `event` is stable across renders (computeTurns reuses
// the same SivruEvent references), but `fromSearch` is rebuilt on every
// computeSearchProvenance call — same SHAPE for unchanged links, different
// REFERENCE. Structural compare keeps unchanged rows from re-rendering
// when only some other turn / event grew.
//
// The big win: in a 5,000-row session that adds one event, this lets ~4,999
// rows skip re-render entirely.
export const TimelineEvent = memo(TimelineEventInner, (prev, next) => {
  if (prev.event !== next.event) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.consumerCount !== next.consumerCount) return false;
  if (prev.onSelect !== next.onSelect) return false;
  // fromSearch — null/undefined-stable comparison, then structural.
  const a = prev.fromSearch ?? null;
  const b = next.fromSearch ?? null;
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.searchEventIndex === b.searchEventIndex &&
    a.chunkIndex === b.chunkIndex &&
    a.filePath === b.filePath &&
    a.startLine === b.startLine &&
    a.endLine === b.endLine
  );
});
