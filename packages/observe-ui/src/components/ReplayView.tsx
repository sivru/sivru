// Replay-diff view (DESIGN.md §6.5).
//
// Shows the engineer "this is what your session would have looked like
// with sivru installed." Layout:
//
//   ┌─ Tokens ─┐  ┌─ Saved ─┐  ┌─ Replaceable ─┐  ┌─ Turns ─┐
//   │  142k    │  │  64%    │  │      8        │  │   7     │
//   │  actual  │  │ amber   │  │ tool calls    │  │         │
//   └──────────┘  └─────────┘  └───────────────┘  └─────────┘
//
//   per-event table with replaceable rows highlighted in amber:
//
//     time   ▸ tool         actual → counterfactual   notes
//     14:01  • Bash grep    1,200  →    300           [↑ would be search]
//     14:01  • Read auth.ts 1,800  →    300           [↑ would be search]
//     14:02  ▸▸ assistant    150  →    150
//
// The "side-by-side" timeline from DESIGN.md §6.5 is deferred to v0.2 —
// the single annotated table is more compact, screenshot-able, and
// easier to scan in tight viewports. The "with-sivru | without-sivru"
// columnar layout adds visual weight for marketing screenshots; ship
// once the annotated table proves out the data shape.

import { useEffect, useRef, useState } from "react";
import { fetchSessionReplay } from "../api";
import type { ReplayedEvent, SessionReplay, Session } from "../types";
import { formatTokenCount } from "../turns";
import { formatTimestamp, truncate } from "../util";

/** Initial render cap — large sessions can run into 5k+ events; rendering
 *  every row up-front stalls the first paint. The user can opt into the
 *  full list via a "Show all" button. */
const INITIAL_ROW_CAP = 500;

/** When `replaceable / total` is below this fraction, the all-events view
 *  is mostly noise — auto-default to the replaceable filter so the user
 *  sees the interesting rows first. */
const REPLACEABLE_AUTO_FILTER_RATIO = 0.05;

type Props = {
  selectedSession: Session | null;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: SessionReplay }
  | { status: "error"; message: string };

export function ReplayView({ selectedSession }: Props): JSX.Element | null {
  const [state, setState] = useState<LoadState>({ status: "idle" });
  // null = "auto" (pick based on event count). Boolean is the user's
  // explicit override.
  const [filterOverride, setFilterOverride] = useState<
    "all" | "replaceable" | null
  >(null);
  const [showAll, setShowAll] = useState(false);
  // Per-session cache: switching back to a previously-viewed session
  // skips the spinner flash. Bounded growth (one entry per visited
  // session in the page's lifetime — fine for typical usage).
  const cacheRef = useRef<Map<string, SessionReplay>>(new Map());
  // Bumped manually by the refresh button; used as an effect dep to
  // force a re-fetch even when the session id hasn't changed. Useful
  // for live sessions where the underlying jsonl is still growing.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (selectedSession === null) {
      setState({ status: "idle" });
      return;
    }
    setShowAll(false);
    setFilterOverride(null);

    // Use cache when available — but only on the initial visit. Manual
    // refresh (refreshTick > 0 for this session) bypasses the cache.
    const cached = cacheRef.current.get(selectedSession.id);
    if (cached !== undefined && refreshTick === 0) {
      setState({ status: "ready", data: cached });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    fetchSessionReplay(selectedSession.id)
      .then((data) => {
        if (cancelled) return;
        cacheRef.current.set(selectedSession.id, data);
        setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "unknown error";
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id, refreshTick]);

  if (selectedSession === null) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-sivru-mute">
        <div className="max-w-md space-y-2">
          <div className="text-base text-sivru-text">
            Select a session in the Sessions tab, then come back here.
          </div>
          <div className="text-[12px]">
            Replay shows what your session would have cost with sivru — token
            counts, replaceable tool calls, and counterfactual savings, all
            offline (no API calls).
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-sivru-mute">
        <div className="inline-flex items-center gap-2">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-sivru-amber opacity-50"></span>
            <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-sivru-amber"></span>
          </span>
          <span>computing replay…</span>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-red-400">
        replay failed: {state.message}
      </div>
    );
  }

  if (state.status === "idle") {
    return null;
  }

  const replay = state.data;
  const turnCount = replay.events.filter((e) => e.kind === "user_message").length;
  const totalEvents = replay.events.length;
  const replaceableCount = replay.totals.replaceableCallCount;
  // Auto-pick the filter when the user hasn't explicitly chosen. If most
  // events are not replaceable (5k+ events with 8 replaceable), the
  // all-events default buries the signal — flip to replaceable.
  const effectiveFilter: "all" | "replaceable" =
    filterOverride !== null
      ? filterOverride
      : replaceableCount > 0 &&
          replaceableCount / Math.max(1, totalEvents) <
            REPLACEABLE_AUTO_FILTER_RATIO
        ? "replaceable"
        : "all";
  const visibleEvents =
    effectiveFilter === "replaceable"
      ? replay.events.filter((e) => e.replaceableBySivru)
      : replay.events;
  const cappedEvents =
    showAll || visibleEvents.length <= INITIAL_ROW_CAP
      ? visibleEvents
      : visibleEvents.slice(0, INITIAL_ROW_CAP);
  const hiddenCount = visibleEvents.length - cappedEvents.length;

  return (
    <div className="flex h-full flex-col">
      {/* Header strip — session id + filter toggle + refresh */}
      <div className="flex items-center gap-3 border-b border-sivru-border bg-sivru-panel/40 px-4 py-2 text-[11px]">
        <span className="font-mono text-sivru-mute">replay</span>
        <span className="text-sivru-mute">·</span>
        <span className="font-mono text-sivru-text">
          {selectedSession.id.slice(0, 8)}
        </span>
        <button
          type="button"
          onClick={() => setRefreshTick((t) => t + 1)}
          title="Re-fetch the replay (useful for live sessions whose jsonl is still growing)"
          className="ml-2 rounded-sivru border border-transparent px-1.5 py-0.5 font-mono text-[11px] text-sivru-mute hover:border-sivru-border hover:text-sivru-text"
        >
          ↻ refresh
        </button>
        <span className="ml-auto flex items-center gap-1">
          {(["all", "replaceable"] as const).map((mode) => {
            const active = mode === effectiveFilter;
            const isAuto = filterOverride === null && active;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setFilterOverride(mode);
                  setShowAll(false);
                }}
                className={
                  "rounded-sivru border px-2 py-0.5 transition-colors " +
                  (active
                    ? "border-sivru-amber/40 bg-sivru-amber/15 text-sivru-amber"
                    : "border-transparent text-sivru-mute hover:text-sivru-text")
                }
                title={
                  isAuto
                    ? "Auto-selected: replaceable calls are <5% of events on this session"
                    : undefined
                }
              >
                {mode === "all"
                  ? `all events (${totalEvents})`
                  : `replaceable (${replaceableCount})`}
                {isAuto && " ·  auto"}
              </button>
            );
          })}
        </span>
      </div>

      {/* Scoreboard — 4-card metric strip */}
      <ReplayScoreboard replay={replay} turnCount={turnCount} />

      {/* Annotated event table */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleEvents.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-sivru-mute">
            {effectiveFilter === "replaceable"
              ? "No replaceable tool calls in this session — sivru wouldn't have changed anything."
              : "no events"}
          </div>
        ) : (
          <>
            <ReplayEventTable events={cappedEvents} />
            {hiddenCount > 0 && (
              <div className="flex items-center justify-center gap-3 border-t border-sivru-border bg-sivru-panel/40 px-4 py-3 text-[11px]">
                <span className="text-sivru-mute">
                  Showing {cappedEvents.length.toLocaleString()} of{" "}
                  {visibleEvents.length.toLocaleString()} —{" "}
                  {hiddenCount.toLocaleString()} more (initial cap keeps the
                  first paint snappy on long sessions).
                </span>
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="rounded-sivru border border-sivru-amber/40 bg-sivru-amber/10 px-2 py-0.5 font-mono text-[11px] text-sivru-amber hover:bg-sivru-amber/20"
                >
                  Show all
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---- scoreboard ----------------------------------------------------------

function ReplayScoreboard({
  replay,
  turnCount,
}: {
  replay: SessionReplay;
  turnCount: number;
}): JSX.Element {
  const { totals } = replay;
  // percentSaved can be NEGATIVE when the counterfactual would have been
  // more expensive than actual — typical when the agent did many tiny
  // focused Reads instead of one big grep. We show that honestly: the
  // headline card flips to "more with sivru" framing instead of pretending
  // a negative number is a saving.
  const savedSign = totals.tokensSaved >= 0;
  const percent = Math.abs(totals.percentSaved * 100).toFixed(0);
  const savedLabel = savedSign ? "tokens saved" : "extra w/ sivru";
  const savedHint = savedSign
    ? `${percent}% reduction with sivru`
    : `${percent}% MORE — counterfactual costs more on this session (lots of small focused Reads)`;
  const savedValue = savedSign
    ? formatTokenCount(totals.tokensSaved)
    : `+${formatTokenCount(Math.abs(totals.tokensSaved))}`;
  return (
    <div className="grid shrink-0 grid-cols-4 gap-px border-b border-sivru-border bg-sivru-border">
      <ScoreCard
        label="actual tokens"
        value={formatTokenCount(totals.actualTokens)}
        hint="what the session really cost"
      />
      <ScoreCard
        label={savedLabel}
        value={savedValue}
        hint={savedHint}
        highlight={savedSign}
        warn={!savedSign}
      />
      <ScoreCard
        label="replaceable calls"
        value={String(totals.replaceableCallCount)}
        hint="grep / Read / glob → search"
      />
      <ScoreCard
        label="turns"
        value={String(turnCount)}
        hint={`${replay.events.length} events total`}
      />
    </div>
  );
}

function ScoreCard({
  label,
  value,
  hint,
  highlight = false,
  warn = false,
}: {
  label: string;
  value: string;
  hint?: string;
  highlight?: boolean;
  warn?: boolean;
}): JSX.Element {
  const valueColor = warn
    ? "text-sivru-warn"
    : highlight
      ? "text-sivru-amber"
      : "text-sivru-text";
  return (
    <div className="flex flex-col bg-sivru-panel px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-sivru-mute">
        {label}
      </div>
      <div className={"mt-1 font-mono text-2xl " + valueColor}>{value}</div>
      {hint !== undefined && (
        <div className="mt-1 text-[10px] text-sivru-mute">{hint}</div>
      )}
    </div>
  );
}

// ---- event table ---------------------------------------------------------

function ReplayEventTable({
  events,
}: {
  events: readonly ReplayedEvent[];
}): JSX.Element {
  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 bg-sivru-bg">
        <tr className="border-b border-sivru-border text-[10px] uppercase tracking-wider text-sivru-mute">
          <th className="px-3 py-1.5 text-left font-normal">time</th>
          <th className="px-3 py-1.5 text-left font-normal">event</th>
          <th className="px-3 py-1.5 text-right font-normal">actual</th>
          <th className="px-3 py-1.5 text-right font-normal">w/ sivru</th>
          <th className="px-3 py-1.5 text-left font-normal">notes</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <ReplayEventRow key={e.index} event={e} />
        ))}
      </tbody>
    </table>
  );
}

function ReplayEventRow({ event }: { event: ReplayedEvent }): JSX.Element {
  const ts = formatTimestamp(event.ts);
  const saved = event.actualTokens - event.counterfactualTokens;
  const isReplaceable = event.replaceableBySivru;
  const rowClass = isReplaceable
    ? "border-b border-sivru-border/40 bg-sivru-amber/5"
    : "border-b border-sivru-border/30 hover:bg-sivru-panel/40";
  const labelText =
    event.kind === "tool_use"
      ? `▸ ${event.tool ?? "tool"}`
      : event.kind === "tool_result"
        ? `↳ ${event.tool ?? "result"}`
        : event.kind === "user_message"
          ? "❝ user"
          : event.kind === "assistant_message"
            ? "assistant"
            : event.kind;
  const snippet =
    event.textSnippet !== undefined && event.textSnippet.length > 0
      ? truncate(event.textSnippet.replace(/\s+/g, " ").trim(), 80)
      : "";
  return (
    <tr className={rowClass}>
      <td className="px-3 py-1 font-mono text-[11px] text-sivru-mute">{ts}</td>
      <td className="px-3 py-1 font-mono text-[11px] text-sivru-text">
        {labelText}
        {snippet.length > 0 && (
          <span className="ml-2 text-sivru-mute">{snippet}</span>
        )}
      </td>
      <td className="px-3 py-1 text-right font-mono text-[11px] text-sivru-text">
        {event.actualTokens > 0 ? formatTokenCount(event.actualTokens) : "—"}
      </td>
      <td
        className={
          "px-3 py-1 text-right font-mono text-[11px] " +
          (saved > 0 ? "text-sivru-amber" : "text-sivru-mute")
        }
      >
        {event.counterfactualTokens > 0
          ? formatTokenCount(event.counterfactualTokens)
          : "—"}
      </td>
      <td className="px-3 py-1 font-mono text-[10px] text-sivru-mute">
        {isReplaceable && (
          <span
            className="rounded border border-sivru-amber/40 bg-sivru-amber/10 px-1.5 py-px text-sivru-amber"
            title={`If sivru had been available, this would have been a sivru.search call. Saves ~${formatTokenCount(saved)} tokens.`}
          >
            ↑ would be search · saved ~{formatTokenCount(saved)}
          </span>
        )}
      </td>
    </tr>
  );
}
