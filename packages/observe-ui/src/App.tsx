import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fetchEvents,
  fetchHealth,
  fetchSessionSavings,
  fetchSessions,
  subscribeToEvents,
} from "./api";
import type { HealthResponse } from "./api";
import { SessionList } from "./components/SessionList";
import { EventFeed } from "./components/EventFeed";
import { Inspector } from "./components/Inspector";
import { Banner } from "./components/Banner";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { SavingsFooter } from "./components/SavingsFooter";
import { BenchView } from "./components/BenchView";
import { CostsView } from "./components/CostsView";
import { ReplayView } from "./components/ReplayView";
import { SetupChecklist } from "./components/SetupChecklist";
import { useKeyboardNav } from "./hooks/useKeyboardNav";
import { computeTurns } from "./turns";
import { computeSearchProvenance } from "./search-provenance";
import type { Session, SessionSavings, SivruEvent } from "./types";
import { isLive, isSivruSearchTool } from "./util";

type View = "sessions" | "replay" | "costs" | "bench";

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

const WIRE_UP_HELP_URL = "https://github.com/sivru/sivru#observe";

// Stable reference for the "no events yet" state. Avoids feeding a fresh
// `[]` into useMemo deps on each render while a session is loading.
const EMPTY_EVENTS: SivruEvent[] = [];

export function App(): JSX.Element {
  const [sessionsState, setSessionsState] = useState<LoadState<Session[]>>({
    status: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventsState, setEventsState] = useState<LoadState<SivruEvent[]>>({
    status: "idle",
  });
  // Index into eventsState.data of the currently-inspected event.
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | null>(
    null,
  );
  const [filter, setFilter] = useState<string>("");
  const [savings, setSavings] = useState<SessionSavings | null>(null);
  const [savingsLoading, setSavingsLoading] = useState<boolean>(false);
  const [view, setView] = useState<View>("sessions");
  const [costsSinceDays, setCostsSinceDays] = useState<number>(7);
  // SSE connection: true once the first event has arrived (or the stream
  // has otherwise indicated it's open). Drives the "connected" pulse.
  const [streamConnected, setStreamConnected] = useState<boolean>(false);
  // Set of expanded turn array-indices (0-based). Defaults to {latest}.
  const [expandedTurnIndices, setExpandedTurnIndices] = useState<Set<number>>(
    new Set(),
  );
  // Project filter (sidebar). null = "all projects".
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  // Whether to group sessions whose worktree dir was deleted under their
  // inferred parent project. Persisted across reloads. Defaults to ON
  // because the typical user surfaces this exact issue ("my worktrees
  // show as separate projects").
  const [groupInferred, setGroupInferredState] = useState<boolean>(() => {
    try {
      const v = window.localStorage.getItem("sivru:groupInferred");
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  });
  const setGroupInferred = (next: boolean): void => {
    setGroupInferredState(next);
    // If the user disables grouping while filtered to an inferred-collapsed
    // project, that filter id becomes meaningless — drop it.
    if (!next && selectedProject !== null) {
      setSelectedProject(null);
    }
    try {
      window.localStorage.setItem("sivru:groupInferred", next ? "1" : "0");
    } catch {
      // ignore
    }
  };
  // Connection health. After 2 consecutive /api/health failures we render
  // the connection-lost banner; on next success we hide it.
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLost, setHealthLost] = useState<boolean>(false);
  const healthFailRef = useRef<number>(0);
  const healthTickRef = useRef<number>(0);

  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const inspectorRef = useRef<HTMLDivElement | null>(null);

  // Re-probe sessions + health. Called once at mount and again whenever the
  // user clicks [Reconnect now] in the connection-lost banner.
  const reloadSessions = useCallback((): void => {
    fetchSessions()
      .then((res) => {
        setSessionsState({ status: "ready", data: res.sessions });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "unknown error";
        setSessionsState({ status: "error", message });
      });
  }, []);

  useEffect(() => {
    reloadSessions();
  }, [reloadSessions]);

  // Background health pulse — fires every 8s when the page is visible.
  // After 2 consecutive failures, show the connection banner; clear on
  // first success thereafter.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (cancelled || document.hidden) return;
      try {
        const h = await fetchHealth();
        if (cancelled) return;
        setHealth(h);
        healthFailRef.current = 0;
        if (healthLost) setHealthLost(false);
      } catch {
        if (cancelled) return;
        healthFailRef.current += 1;
        if (healthFailRef.current >= 2) setHealthLost(true);
      }
    };
    void tick();
    healthTickRef.current = window.setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      if (healthTickRef.current !== 0) {
        clearInterval(healthTickRef.current);
        healthTickRef.current = 0;
      }
    };
  }, [healthLost]);

  const reconnect = useCallback((): void => {
    healthFailRef.current = 0;
    setHealthLost(false);
    reloadSessions();
  }, [reloadSessions]);

  useEffect(() => {
    // Reset all per-session state any time the user switches sessions.
    setSelectedEventIndex(null);
    setFilter("");
    setSavings(null);
    if (selectedId === null) {
      setEventsState({ status: "idle" });
      return;
    }
    let cancelled = false;

    // Open the SSE live-tail. Server sends ALL existing events as we connect,
    // then streams new ones as they're appended. We accumulate into eventsState
    // — but BATCHED. Naively setStating per event triggers a full re-render
    // per event, which on a 5,000+ event session does ~50 × O(N²) work for
    // the turn / provenance computations cascading off it. Buffering arrivals
    // into 50 ms windows drops 5,940 renders to ~50 with no human-visible
    // delay during live tail.
    setEventsState({ status: "loading" });
    setStreamConnected(false);
    let eventsSoFar: SivruEvent[] = [];
    let firstEventReceived = false;
    let activeStream: { close: () => void } | null = null;
    let retryAttempted = false;
    let retryTimer: number | null = null;
    let pendingBatch: SivruEvent[] = [];
    let batchTimer: number | null = null;
    const BATCH_WINDOW_MS = 50;

    const flushBatch = (): void => {
      if (pendingBatch.length === 0) return;
      const incoming = pendingBatch;
      pendingBatch = [];
      eventsSoFar = [...eventsSoFar, ...incoming];
      setEventsState({ status: "ready", data: eventsSoFar });
    };

    const open = (): void => {
      activeStream = subscribeToEvents(
        selectedId,
        (event) => {
          if (cancelled) return;
          setStreamConnected(true);
          // Once events flow we treat the connection as healthy — clear the
          // retry budget so future drops can also retry once.
          retryAttempted = false;

          if (!firstEventReceived) {
            // Flush the very first event immediately so the loading state
            // clears without the 50 ms batch delay.
            firstEventReceived = true;
            eventsSoFar = [event];
            setEventsState({ status: "ready", data: eventsSoFar });
            return;
          }

          pendingBatch.push(event);
          if (batchTimer === null) {
            batchTimer = window.setTimeout(() => {
              batchTimer = null;
              flushBatch();
            }, BATCH_WINDOW_MS);
          }
        },
        () => {
          if (cancelled) return;
          // Three regimes:
          //  - never received any events: fall back to a one-shot HTTP fetch
          //    so the user sees SOMETHING.
          //  - received events but stream dropped: retry once after a short
          //    backoff (covers transient server restarts mid-session).
          //  - retry already used: surrender; the /api/health probe will
          //    surface the connection-lost banner if the server is gone.
          if (!firstEventReceived) {
            fetchEvents(selectedId, 500)
              .then((res) => {
                if (cancelled) return;
                setEventsState({ status: "ready", data: res.events });
              })
              .catch((err: unknown) => {
                if (cancelled) return;
                const message =
                  err instanceof Error ? err.message : "unknown error";
                setEventsState({ status: "error", message });
              });
            return;
          }
          if (!retryAttempted) {
            retryAttempted = true;
            setStreamConnected(false);
            if (activeStream !== null) activeStream.close();
            activeStream = null;
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              if (!cancelled) open();
            }, 1500);
          }
        },
      );
    };

    open();
    const stream = {
      close: () => {
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        if (batchTimer !== null) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        // Drop pendingBatch — those events belong to the session we're
        // leaving; flushing them would race with the new session's load.
        pendingBatch = [];
        if (activeStream !== null) activeStream.close();
        activeStream = null;
      },
    };

    // Savings runs in parallel; refreshes once when the session is selected.
    // (Could re-fetch on each new SSE event, but that's expensive — a manual
    // refresh button would be cleaner; defer that polish.)
    setSavingsLoading(true);
    fetchSessionSavings(selectedId)
      .then((res) => {
        if (cancelled) return;
        setSavings(res);
      })
      .catch(() => {
        // Footer just stays hidden on error.
      })
      .finally(() => {
        if (cancelled) return;
        setSavingsLoading(false);
      });

    return () => {
      cancelled = true;
      stream.close();
    };
  }, [selectedId]);

  // Reuse a single empty-array reference for non-ready states so the
  // downstream useMemos don't see a fresh `[]` on every render and
  // recompute pointlessly while the session loads.
  const events: SivruEvent[] =
    eventsState.status === "ready" ? eventsState.data : EMPTY_EVENTS;

  // Single source of truth for turn structure — computed once per render
  // and passed to EventFeed instead of recomputed there. Memoized on the
  // events array reference so it only re-runs when SSE pushes a new event
  // (events spread = new reference).
  const turns = useMemo(() => computeTurns(events), [events]);
  const turnCount = turns.length;
  // Search → consumer linking (Tier 1 Phase 2 of the coaching surface).
  // Computed once per render; passed to EventFeed and Inspector so both
  // can render provenance badges and "used by" markers from the same data.
  const searchProvenance = useMemo(() => computeSearchProvenance(events), [events]);

  // Auto-expand the new latest turn when one arrives, but PRESERVE any
  // older turns the user has manually toggled open. Earlier code replaced
  // the whole Set, which silently collapsed the user's selections.
  const lastSeenTurnCountRef = useRef<number>(0);
  useEffect(() => {
    if (turnCount === 0) {
      lastSeenTurnCountRef.current = 0;
      setExpandedTurnIndices(new Set());
      return;
    }
    if (turnCount !== lastSeenTurnCountRef.current) {
      lastSeenTurnCountRef.current = turnCount;
      setExpandedTurnIndices((prev) => {
        const next = new Set(prev);
        next.add(turnCount - 1);
        return next;
      });
    }
  }, [turnCount]);

  // Memoize the selected Session lookup. Both the header status badge and
  // the replay-tab pane derive `selectedSession` from `sessions.find(...)`;
  // pre-fix, both fired a linear scan on every App render, even when
  // selection and sessions hadn't changed. With ~150 sessions × ~50 renders
  // per second during live tail, that's not catastrophic but it's pure
  // waste.
  const selectedSession = useMemo<Session | null>(() => {
    if (sessionsState.status !== "ready") return null;
    if (selectedId === null) return null;
    return sessionsState.data.find((s) => s.id === selectedId) ?? null;
  }, [sessionsState, selectedId]);

  // useCallback so the function reference is stable across renders. Without
  // this, every App render hands EventFeed a fresh `toggleTurn`, which would
  // bust React.memo() on TurnHeader / TimelineEvent (props would compare
  // unequal even when nothing else changed).
  const toggleTurn = useCallback((turnIdx: number): void => {
    setExpandedTurnIndices((prev) => {
      const next = new Set(prev);
      if (next.has(turnIdx)) next.delete(turnIdx);
      else next.add(turnIdx);
      return next;
    });
  }, []);

  // Stable handler for row selection — same memo-friendly story as toggleTurn.
  const handleSelectEvent = useCallback((index: number | null): void => {
    setSelectedEventIndex(index);
  }, []);

  // Filter deferred via useDeferredValue: input stays responsive while
  // React schedules the (potentially expensive) filter recompute as a
  // low-priority update. On a 6,000-event session with active filter,
  // each keystroke triggers ~6,000 string ops; without deferral the
  // input visibly lags during fast typing.
  const deferredFilter = useDeferredValue(filter);

  // Compute the indices that pass the case-insensitive text filter. Empty
  // filter => everything visible (avoid copying the array).
  const visibleIndices = useMemo<number[]>(() => {
    const q = deferredFilter.trim().toLowerCase();
    if (q.length === 0) return events.map((_, i) => i);
    return events
      .map((e, i) => {
        const text = (e.text ?? "").toLowerCase();
        const tool = (e.tool ?? "").toLowerCase();
        return text.includes(q) || tool.includes(q) ? i : -1;
      })
      .filter((i) => i >= 0);
  }, [events, deferredFilter]);

  // If the current selection got filtered out, drop it.
  useEffect(() => {
    if (selectedEventIndex === null) return;
    if (!visibleIndices.includes(selectedEventIndex)) {
      setSelectedEventIndex(null);
    }
  }, [visibleIndices, selectedEventIndex]);

  const selectedEvent: SivruEvent | null =
    selectedEventIndex !== null && events[selectedEventIndex] !== undefined
      ? events[selectedEventIndex]
      : null;

  const hasSivruSearch = useMemo<boolean>(() => {
    if (events.length === 0) return true; // suppress banner on empty/loading
    return events.some(
      (e) => e.kind === "tool_use" && isSivruSearchTool(e.tool),
    );
  }, [events]);

  const showZeroSearchNudge =
    eventsState.status === "ready" &&
    events.length > 0 &&
    !hasSivruSearch;

  // Keyboard navigation. Active when we have a session loaded with events.
  useKeyboardNav({
    enabled: eventsState.status === "ready" && visibleIndices.length > 0,
    onNext: () => {
      if (visibleIndices.length === 0) return;
      if (selectedEventIndex === null) {
        setSelectedEventIndex(visibleIndices[0] ?? null);
        return;
      }
      const pos = visibleIndices.indexOf(selectedEventIndex);
      if (pos === -1) {
        setSelectedEventIndex(visibleIndices[0] ?? null);
        return;
      }
      const next = visibleIndices[Math.min(pos + 1, visibleIndices.length - 1)];
      if (next !== undefined) setSelectedEventIndex(next);
    },
    onPrev: () => {
      if (visibleIndices.length === 0) return;
      if (selectedEventIndex === null) {
        setSelectedEventIndex(visibleIndices[0] ?? null);
        return;
      }
      const pos = visibleIndices.indexOf(selectedEventIndex);
      if (pos === -1) {
        setSelectedEventIndex(visibleIndices[0] ?? null);
        return;
      }
      const prev = visibleIndices[Math.max(pos - 1, 0)];
      if (prev !== undefined) setSelectedEventIndex(prev);
    },
    onEnter: () => {
      // No focusable elements inside the inspector yet; just scroll it to
      // the top so it's visually anchored. Cheap UX placeholder.
      if (selectedEventIndex === null) return;
      if (inspectorRef.current !== null) {
        inspectorRef.current.scrollTop = 0;
      }
    },
    onEscape: () => {
      // If the filter input is focused, blur and clear it; otherwise drop
      // the event selection.
      const active = document.activeElement;
      if (active === filterInputRef.current && filterInputRef.current !== null) {
        if (filter.length > 0) setFilter("");
        filterInputRef.current.blur();
        return;
      }
      if (selectedEventIndex !== null) {
        setSelectedEventIndex(null);
      }
    },
    onQuickFilter: () => {
      if (filterInputRef.current !== null) {
        filterInputRef.current.focus();
        filterInputRef.current.select();
      }
    },
  });

  return (
    <div className="flex h-full w-full flex-col bg-sivru-bg text-sivru-text">
      {healthLost && <ConnectionBanner onReconnect={reconnect} />}
      <header className="flex h-10 shrink-0 items-center gap-4 border-b border-sivru-border px-4">
        <div className="text-sm font-medium tracking-tight">
          <span className="text-sivru-amber">sivru</span>
          <span className="text-sivru-mute"> / </span>
          <span>observe</span>
        </div>
        <nav className="flex gap-1 text-xs">
          {(["sessions", "replay", "costs", "bench"] as const).map((v) => {
            const active = view === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={
                  "rounded-sivru border px-2 py-0.5 capitalize transition-colors " +
                  (active
                    ? "border-sivru-amber/40 bg-sivru-amber/15 text-sivru-amber"
                    : "border-transparent text-sivru-mute hover:text-sivru-text")
                }
              >
                {v}
              </button>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <SessionStatusBadge session={selectedSession} events={events} />
          <span className="text-sivru-mute">
            {sessionsState.status === "ready"
              ? `${sessionsState.data.length} session${sessionsState.data.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
      </header>
      {view === "bench" ? (
        <BenchView />
      ) : view === "costs" ? (
        <main className="min-h-0 flex-1">
          <CostsView
            sinceDays={costsSinceDays}
            onSinceDaysChange={(n) => {
              setCostsSinceDays(Number.isFinite(n) ? n : 7);
            }}
          />
        </main>
      ) : view === "replay" ? (
        <main className="flex min-h-0 flex-1">
          {/* Reuse the sidebar — replay needs a session picker too. */}
          <aside className="w-60 shrink-0 border-r border-sivru-border bg-sivru-panel">
            <SessionList
              state={sessionsState}
              selectedId={selectedId}
              onSelect={setSelectedId}
              selectedProject={selectedProject}
              onSelectProject={setSelectedProject}
              groupInferred={groupInferred}
              onToggleGroupInferred={setGroupInferred}
            />
          </aside>
          <section className="flex min-w-0 flex-1 flex-col bg-sivru-bg">
            <ReplayView selectedSession={selectedSession} />
          </section>
        </main>
      ) : sessionsState.status === "ready" && sessionsState.data.length === 0 ? (
        <main className="min-h-0 flex-1">
          <SetupChecklist health={health} />
        </main>
      ) : (
      <main className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-sivru-border bg-sivru-panel">
          <SessionList
            state={sessionsState}
            selectedId={selectedId}
            onSelect={setSelectedId}
            selectedProject={selectedProject}
            onSelectProject={setSelectedProject}
            groupInferred={groupInferred}
            onToggleGroupInferred={setGroupInferred}
          />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col bg-sivru-bg">
          {showZeroSearchNudge && (
            <Banner tone="amber">
              <span>
                No sivru.search calls in this session — wire up the
                sivru-search subagent.
              </span>
              <a
                href={WIRE_UP_HELP_URL}
                target="_blank"
                rel="noopener"
                className="ml-auto whitespace-nowrap underline hover:no-underline"
              >
                Show me how →
              </a>
            </Banner>
          )}
          <div className="min-h-0 flex-1">
            <EventFeed
              sessionId={selectedId}
              state={eventsState}
              turns={turns}
              provenance={searchProvenance}
              sessionSavings={savings}
              selectedIndex={selectedEventIndex}
              onSelect={handleSelectEvent}
              filter={filter}
              onFilterChange={setFilter}
              filterInputRef={filterInputRef}
              visibleIndices={visibleIndices}
              expandedTurnIndices={expandedTurnIndices}
              onToggleTurn={toggleTurn}
              connected={streamConnected}
            />
          </div>
          {selectedId !== null && (
            <SavingsFooter savings={savings} loading={savingsLoading} />
          )}
        </section>
        <aside
          ref={inspectorRef}
          className="w-[380px] shrink-0 overflow-hidden border-l border-sivru-border bg-sivru-panel"
        >
          <Inspector
            event={selectedEvent}
            totalEvents={events.length}
            provenance={searchProvenance}
            {...(savings !== null ? { turns: savings.turns } : {})}
          />
        </aside>
      </main>
      )}
    </div>
  );
}

// ----- live status badge in the top header -------------------------------

function SessionStatusBadge({
  session,
  events,
}: {
  session: Session | null;
  events: SivruEvent[];
}): JSX.Element {
  if (session === null) return <span aria-hidden></span>;
  const live = isLive(session.updatedAt);
  const turnCount = events.filter((e) => e.kind === "user_message").length;

  if (live) {
    return (
      <span className="flex items-center gap-1.5 text-sivru-amber">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-sivru-amber opacity-50"></span>
          <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-sivru-amber"></span>
        </span>
        <span className="font-mono text-[11px]">
          live · {turnCount} turn{turnCount === 1 ? "" : "s"}
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-sivru-mute">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-sivru-mute"></span>
      <span className="font-mono text-[11px]">
        ended · {turnCount} turn{turnCount === 1 ? "" : "s"}
      </span>
    </span>
  );
}
