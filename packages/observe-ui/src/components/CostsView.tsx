import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { fetchAggregateSavings } from "../api";
import type { AggregateSavings } from "../types";

export type CostsViewProps = {
  /** Selected time-range in days. Default 7. The parent owns this state. */
  sinceDays: number;
  /** Notifies the parent so it can sync URL or other UI. */
  onSinceDaysChange: (n: number) => void;
};

// TODO: AggregateSavings in types.ts currently exposes only `sessionsCount` and
// `totals`. The parent integrator is expected to add a top-N `sessions` array
// to the server response + the shared type. Until then we read it through this
// local row shape and fall back to [] so the table degrades gracefully.
type SessionRow = {
  id: string;
  actualTokens: number;
  counterfactualTokens: number;
  tokensSaved: number;
  replaceableCallCount: number;
};

type AggregateSavingsWithSessions = AggregateSavings & {
  sessions?: SessionRow[];
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: AggregateSavingsWithSessions }
  | { status: "error"; message: string };

type RangeOption = { label: string; days: number | undefined };

const RANGE_OPTIONS: ReadonlyArray<RangeOption> = [
  { label: "1d", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "all", days: undefined },
];

const TOP_SESSIONS_LIMIT = 20;

/**
 * Formats a token count in a compact human form.
 *
 *   formatTokens(0)        === "0"
 *   formatTokens(950)      === "950"
 *   formatTokens(1500)     === "1.5k"
 *   formatTokens(1234567)  === "1.23M"
 *   formatTokens(-5000)    === "-5.0k"
 */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0%";
  return `${(fraction * 100).toFixed(1)}%`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function isActiveRange(
  optDays: number | undefined,
  current: number | undefined,
): boolean {
  if (optDays === undefined && current === undefined) return true;
  return optDays === current;
}

export function CostsView(props: CostsViewProps): JSX.Element {
  const { sinceDays, onSinceDaysChange } = props;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // bumped to force a refetch on retry without changing sinceDays
  const [retryToken, setRetryToken] = useState(0);

  // `sinceDays` is always a number on the props — Number.isFinite catches the
  // sentinel we use internally for "all" if a parent ever wires it that way.
  const effectiveSince: number | undefined = Number.isFinite(sinceDays)
    ? sinceDays
    : undefined;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const data = await fetchAggregateSavings(effectiveSince);
        if (cancelled || controller.signal.aborted) return;
        setState({ status: "ready", data: data as AggregateSavingsWithSessions });
      } catch (err: unknown) {
        if (cancelled || controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", message });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [effectiveSince, retryToken]);

  const onRetry = useCallback(() => {
    setRetryToken((n) => n + 1);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <RangeSelector
        current={effectiveSince}
        onChange={(days) => {
          // Convention: parent owns the number. "all" is represented as a
          // numerically-large sentinel here so the prop type can stay `number`
          // without us inventing a new union; the api call uses `undefined`.
          // We pass NaN to mean "all" so Number.isFinite filters it back out.
          onSinceDaysChange(days ?? Number.NaN);
        }}
      />

      {state.status === "loading" && (
        <div className="flex flex-1 items-center justify-center text-xs text-sivru-mute">
          Loading costs…
        </div>
      )}

      {state.status === "error" && (
        <div className="flex flex-1 items-center justify-center gap-3 text-xs">
          <span className="text-red-400">
            Couldn't load costs: {state.message}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-sivru-border px-2 py-0.5 text-sivru-text hover:bg-sivru-panel"
          >
            [retry]
          </button>
        </div>
      )}

      {state.status === "ready" && (
        <CostsBody report={state.data} sinceDays={sinceDays} />
      )}
    </div>
  );
}

function RangeSelector(props: {
  current: number | undefined;
  onChange: (days: number | undefined) => void;
}): JSX.Element {
  const { current, onChange } = props;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-sivru-border bg-sivru-panel px-4 py-2">
      <span className="text-xs uppercase tracking-wider text-sivru-mute">
        Range
      </span>
      <div className="flex items-center gap-1">
        {RANGE_OPTIONS.map((opt) => {
          const active = isActiveRange(opt.days, current);
          const cls = active
            ? "border-sivru-amber/40 bg-sivru-amber/20 text-sivru-amber"
            : "border-sivru-border text-sivru-text hover:bg-sivru-panel";
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => onChange(opt.days)}
              className={
                "rounded border px-2 py-0.5 text-xs font-mono transition-colors " +
                cls
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CostsBody(props: {
  report: AggregateSavingsWithSessions;
  sinceDays: number;
}): JSX.Element {
  const { report, sinceDays } = props;
  const { totals } = report;

  if (totals.sessionCount === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-xs text-sivru-mute">
        <div>
          No sessions in the last{" "}
          {Number.isFinite(sinceDays) ? `${sinceDays}d` : "selected range"}.
        </div>
        <div className="text-sivru-mute">
          Try widening the range above (30d / all).
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HeadlineMetrics
        sessionCount={totals.sessionCount}
        actualTokens={totals.actualTokens}
        tokensSaved={totals.tokensSaved}
        percentSaved={totals.percentSaved}
        replaceableCallCount={totals.replaceableCallCount}
      />
      <TopSessionsTable sessions={report.sessions ?? []} />
    </div>
  );
}

function HeadlineMetrics(props: {
  sessionCount: number;
  actualTokens: number;
  tokensSaved: number;
  percentSaved: number;
  replaceableCallCount: number;
}): JSX.Element {
  const {
    sessionCount,
    actualTokens,
    tokensSaved,
    percentSaved,
    replaceableCallCount,
  } = props;

  const sign = tokensSaved > 0 ? "+" : tokensSaved < 0 ? "-" : "";
  const savedAbs = Math.abs(tokensSaved);
  const savedToneCls =
    tokensSaved > 0 ? "text-sivru-amber" : "text-sivru-mute";

  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-sivru-border bg-sivru-panel/40 p-4 md:grid-cols-4">
      <Stat label="Sessions" value={String(sessionCount)} />
      <Stat label="Actual tokens" value={formatTokens(actualTokens)} />
      <Stat
        label="Tokens saved"
        value={
          <span className={savedToneCls}>
            {sign}
            {formatTokens(savedAbs)}{" "}
            <span className="text-sivru-mute">
              ({formatPercent(percentSaved)})
            </span>
          </span>
        }
      />
      <Stat
        label="Replaceable calls"
        value={String(replaceableCallCount)}
      />
    </div>
  );
}

function Stat(props: {
  label: string;
  value: ReactNode;
}): JSX.Element {
  const { label, value } = props;
  return (
    <div className="flex flex-col gap-1 rounded border border-sivru-border bg-sivru-panel px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-sivru-mute">
        {label}
      </div>
      <div className="font-mono text-lg text-sivru-text">{value}</div>
    </div>
  );
}

function TopSessionsTable(props: { sessions: SessionRow[] }): JSX.Element {
  // Memoize the sort + slice — TopSessionsTable re-renders every time the
  // costs view re-renders, but the actual session list only changes when
  // a new aggregate response lands. Pre-fix: 147 sessions × full sort on
  // every keystroke in the "since" days field.
  const sorted = useMemo(
    () =>
      [...props.sessions]
        .sort((a, b) => b.tokensSaved - a.tokensSaved)
        .slice(0, TOP_SESSIONS_LIMIT),
    [props.sessions],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center border-b border-sivru-border bg-sivru-panel px-4 text-xs uppercase tracking-wider text-sivru-mute">
        Top sessions by tokens saved
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="px-4 py-3 text-xs text-sivru-mute">
            No per-session breakdown available yet.
          </div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-sivru-bg text-sivru-mute">
              <tr className="text-left">
                <th className="px-4 py-2 font-normal">session</th>
                <th className="px-4 py-2 text-right font-normal">used</th>
                <th className="px-4 py-2 text-right font-normal">saved</th>
                <th
                  className="px-4 py-2 text-right font-normal"
                  title="Tokens saved as a fraction of what this session actually used. Always ≤ 100%; negative when sivru's counterfactual would have cost more (typical for sessions full of small focused Reads)."
                >
                  % saved
                </th>
                <th className="px-4 py-2 text-right font-normal">repl. calls</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => {
                const negative = s.tokensSaved < 0;
                const rowToneCls = negative ? "text-sivru-mute" : "text-sivru-text";
                const savedSign = s.tokensSaved > 0 ? "+" : negative ? "-" : "";
                // Match the server's aggregate formula: tokensSaved /
                // actualTokens. Bounded in (-∞, 1] — `actualTokens >=
                // tokensSaved` always since counterfactualTokens >= 0,
                // so positive ratios never exceed 100%. The previous
                // `tokensSaved / counterfactualTokens` could go to 122%+
                // when sivru would have been much cheaper than what the
                // agent actually did, which read as a math bug.
                const pct =
                  s.actualTokens > 0 ? s.tokensSaved / s.actualTokens : 0;
                return (
                  <tr
                    key={s.id}
                    className={
                      "border-b border-sivru-border even:bg-sivru-panel/40 " +
                      rowToneCls
                    }
                  >
                    <td className="px-4 py-1.5 font-mono">{shortId(s.id)}</td>
                    <td className="px-4 py-1.5 text-right font-mono">
                      {formatTokens(s.actualTokens)}
                    </td>
                    <td
                      className={
                        "px-4 py-1.5 text-right font-mono " +
                        (negative
                          ? "text-sivru-mute"
                          : s.tokensSaved > 0
                            ? "text-sivru-amber"
                            : "text-sivru-mute")
                      }
                    >
                      {savedSign}
                      {formatTokens(Math.abs(s.tokensSaved))}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono">
                      {formatPercent(pct)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono">
                      {s.replaceableCallCount}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
