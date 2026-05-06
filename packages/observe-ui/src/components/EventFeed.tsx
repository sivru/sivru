// The center pane: turn-grouped event timeline.
//
// DESIGN.md §6.1 visual hierarchy: turn header rules first, sivru.search
// events loudest in amber, user messages italic-quoted, generic tool
// events dim and bullet-prefixed, tool_results inline-coupled with their
// tool_use parent. Older turns collapse to one-line summaries; the latest
// turn is always expanded.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSavings, SivruEvent } from "../types";
import type { Turn } from "../turns";
import type { ProvenanceResult } from "../search-provenance";
import { TimelineEvent } from "./TimelineEvent";
import { TurnHeader } from "./TurnHeader";

/** Per-turn render cap. A turn with thousands of events (extreme but real
 *  on agent-coding sessions that ran for hours) would otherwise render
 *  thousands of rows on expand. The "show all" affordance lets the user
 *  opt in. */
const PER_TURN_RENDER_CAP = 500;

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

type Props = {
  sessionId: string | null;
  state: LoadState<SivruEvent[]>;
  /** Computed once in App, passed down so we don't re-scan in every child. */
  turns: readonly Turn[];
  /** sivru.search → consumer links, computed once in App. */
  provenance: ProvenanceResult;
  /**
   * Session-wide savings totals, used by TurnHeader to compute per-turn
   * saved-tokens estimates via proportional attribution. Null while the
   * /api/sessions/:id/savings request is in flight.
   */
  sessionSavings: SessionSavings | null;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  filter: string;
  onFilterChange: (value: string) => void;
  filterInputRef: React.RefObject<HTMLInputElement>;
  /** Indices that pass the filter — used to keep keyboard nav consistent. */
  visibleIndices: number[];
  /** Set of expanded turn indices, controlled from App. */
  expandedTurnIndices: Set<number>;
  onToggleTurn: (turnIndex: number) => void;
  /** Connected = SSE stream is open and we've at least seen the schema. */
  connected: boolean;
};

export function EventFeed({
  sessionId,
  state,
  turns,
  provenance,
  sessionSavings,
  selectedIndex,
  onSelect,
  filter,
  onFilterChange,
  filterInputRef,
  visibleIndices,
  expandedTurnIndices,
  onToggleTurn,
  connected,
}: Props): JSX.Element {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  // Per-turn "show all" override. Turns whose array index is in this Set
  // bypass PER_TURN_RENDER_CAP and render every event. Reset on session
  // change.
  const [showAllForTurn, setShowAllForTurn] = useState<Set<number>>(
    () => new Set(),
  );
  useEffect(() => {
    setShowAllForTurn(new Set());
  }, [sessionId]);

  useEffect(() => {
    if (selectedIndex === null) return;
    if (selectedRef.current === null) return;
    selectedRef.current.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const events: SivruEvent[] =
    state.status === "ready" ? state.data : [];

  const visibleSet = useMemo(() => new Set(visibleIndices), [visibleIndices]);
  const filterActive = filter.trim().length > 0;

  if (sessionId === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-sivru-mute">
        select a session to view the timeline
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center gap-2 border-b border-sivru-border bg-sivru-bg px-4 text-xs">
        <span className="uppercase tracking-wider text-sivru-mute">timeline</span>
        <input
          ref={filterInputRef}
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="filter (Cmd/Ctrl+K)"
          aria-label="Filter events by text"
          className="ml-2 w-48 rounded-sivru border border-sivru-border bg-sivru-panel px-2 py-0.5 text-[11px] text-sivru-text placeholder:text-sivru-mute focus:border-sivru-amber focus:outline-none"
        />
        {state.status === "ready" && (
          <span className="ml-auto font-mono text-[11px] text-sivru-mute">
            {filterActive
              ? `${visibleSet.size}/${events.length}`
              : `${events.length}`} event{events.length === 1 ? "" : "s"} · {turns.length} turn{turns.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" && (
          <FirstImpressionConnecting />
        )}
        {state.status === "error" && (
          <div className="px-4 py-3 text-xs text-red-400">
            failed to load events: {state.message}
          </div>
        )}
        {state.status === "ready" && events.length === 0 && (
          <FirstImpressionWaiting connected={connected} />
        )}
        {state.status === "ready" &&
          events.length > 0 &&
          visibleSet.size === 0 && (
            <div className="px-4 py-6 text-center text-xs text-sivru-mute">
              no events match the filter — Esc to clear
            </div>
          )}

        {state.status === "ready" &&
          turns.map((turn, i) => {
            const expanded = expandedTurnIndices.has(i);
            const isLatest = i === turns.length - 1;
            const visibleEvents = filterActive
              ? turn.events.filter((e) => visibleSet.has(e.index))
              : turn.events;
            // Hide entire turn under filter when no events pass.
            if (filterActive && visibleEvents.length === 0) return null;
            // Per-turn cap: render at most PER_TURN_RENDER_CAP events
            // unless the user has clicked "Show all" for this turn.
            // Don't cap when a filter is active — the filter usually
            // already narrows things; capping would hide matches.
            const showAll = filterActive || showAllForTurn.has(i);
            const cappedEvents =
              showAll || visibleEvents.length <= PER_TURN_RENDER_CAP
                ? visibleEvents
                : visibleEvents.slice(0, PER_TURN_RENDER_CAP);
            const hiddenCount = visibleEvents.length - cappedEvents.length;
            return (
              <section key={turn.index === 0 ? "turn-pre" : `turn-${turn.index}`}>
                <TurnHeader
                  turn={turn}
                  turnArrayIndex={i}
                  expanded={expanded}
                  onToggle={onToggleTurn}
                  isLatest={isLatest}
                  sessionSavings={sessionSavings}
                />
                {expanded && (
                  <div className="border-b border-sivru-border/60 bg-sivru-bg/40">
                    {cappedEvents.map((e) => {
                      const isSelected = e.index === selectedIndex;
                      const fromSearch =
                        provenance.consumerByEvent.get(e.index) ?? null;
                      const consumerCount =
                        provenance.consumersBySearch.get(e.index)?.length ?? 0;
                      return (
                        <TimelineEvent
                          key={`${e.sessionId}:${e.index}`}
                          ref={isSelected ? selectedRef : null}
                          event={e}
                          selected={isSelected}
                          fromSearch={fromSearch}
                          consumerCount={consumerCount}
                          onSelect={onSelect}
                        />
                      );
                    })}
                    {hiddenCount > 0 && (
                      <div className="flex items-center gap-3 border-t border-sivru-border/40 bg-sivru-panel/40 px-4 py-2 text-[11px]">
                        <span className="text-sivru-mute">
                          Showing {cappedEvents.length.toLocaleString()} of{" "}
                          {visibleEvents.length.toLocaleString()} events —{" "}
                          {hiddenCount.toLocaleString()} more.
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setShowAllForTurn((prev) => {
                              const next = new Set(prev);
                              next.add(i);
                              return next;
                            })
                          }
                          className="rounded-sivru border border-sivru-amber/40 bg-sivru-amber/10 px-2 py-0.5 font-mono text-[11px] text-sivru-amber hover:bg-sivru-amber/20"
                        >
                          Show all
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
      </div>
    </div>
  );
}

// First-impression states (DESIGN.md §6.3).

function FirstImpressionConnecting(): JSX.Element {
  return (
    <div className="px-4 py-6 text-center text-xs text-sivru-mute">
      <div className="inline-flex items-center gap-2">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-sivru-amber opacity-50"></span>
          <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-sivru-amber"></span>
        </span>
        <span>connecting · 0 events read</span>
      </div>
    </div>
  );
}

function FirstImpressionWaiting({ connected }: { connected: boolean }): JSX.Element {
  if (!connected) {
    return (
      <div className="px-4 py-6 text-center text-xs text-sivru-mute">
        connecting…
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-4 py-6">
      <div className="rounded-sivru border border-sivru-border bg-sivru-panel/30 px-6 py-5 text-center">
        <div className="mb-3 inline-flex items-center gap-2">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-sivru-amber opacity-50"></span>
            <span className="relative inline-block h-2 w-2 rounded-full bg-sivru-amber"></span>
          </span>
          <span className="text-[11px] uppercase tracking-wider text-sivru-amber">
            connected
          </span>
        </div>
        <div className="text-sm text-sivru-text">
          waiting for the first turn
        </div>
        <div className="mt-1 text-xs text-sivru-mute">
          0 events read · events will appear as the agent works
        </div>
      </div>
    </div>
  );
}
