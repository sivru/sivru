// Bench tab — past `sivru bench personal` runs.
//
// Left rail: a list of runs (newest first), each labeled by ISO date.
// Main pane: per-repo, per-model results with a bootstrap CI bar chart.
//
// Data source: GET /api/bench-history (list) + /api/bench-history/:id
// (detail). The CLI writes these JSON files to
// ~/.cache/sivru/bench-history/ — see packages/cli/src/lib/bench-history.ts.

import { useEffect, useMemo, useState } from "react";
import {
  fetchBenchRun,
  fetchBenchRuns,
  type BenchRunDetail,
  type BenchRunModel,
  type BenchRunRepo,
  type BenchRunSummary,
} from "../api";

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

export function BenchView(): JSX.Element {
  const [list, setList] = useState<LoadState<BenchRunSummary[]>>({
    status: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LoadState<BenchRunDetail>>({
    status: "idle",
  });

  useEffect(() => {
    let cancelled = false;
    fetchBenchRuns()
      .then((res) => {
        if (cancelled) return;
        setList({ status: "ready", data: res.runs });
        if (res.runs.length > 0 && selectedId === null) {
          setSelectedId(res.runs[0]!.id);
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setList({ status: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
    // We deliberately run this once on mount; refresh button below
    // re-triggers manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setDetail({ status: "idle" });
      return;
    }
    setDetail({ status: "loading" });
    let cancelled = false;
    fetchBenchRun(selectedId)
      .then((d) => {
        if (cancelled) return;
        setDetail({ status: "ready", data: d });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setDetail({ status: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const runs = list.status === "ready" ? list.data : [];

  return (
    <main className="flex min-h-0 flex-1">
      <aside className="w-60 shrink-0 border-r border-sivru-border bg-sivru-panel">
        <div className="border-b border-sivru-border px-3 py-2 text-xs uppercase tracking-wide text-sivru-mute">
          Past bench runs
        </div>
        {list.status === "loading" && (
          <div className="px-3 py-2 text-xs text-sivru-mute">loading…</div>
        )}
        {list.status === "error" && (
          <div className="px-3 py-2 text-xs text-red-400">
            {list.message}
          </div>
        )}
        {list.status === "ready" && runs.length === 0 && (
          <div className="px-3 py-3 text-xs text-sivru-mute">
            No bench runs yet. Run{" "}
            <code className="rounded bg-sivru-bg px-1 py-0.5 text-[11px] text-sivru-text">
              sivru bench personal
            </code>{" "}
            to populate this list.
          </div>
        )}
        {list.status === "ready" && runs.length > 0 && (
          <ul className="max-h-full overflow-y-auto">
            {runs.map((r) => {
              const active = r.id === selectedId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    className={
                      "block w-full px-3 py-2 text-left text-xs " +
                      (active
                        ? "bg-sivru-amber/10 text-sivru-text"
                        : "text-sivru-mute hover:bg-sivru-bg hover:text-sivru-text")
                    }
                  >
                    <div className="font-mono">{formatDate(r.startedAt)}</div>
                    <div className="text-[10px] text-sivru-mute">{r.id}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-sivru-bg p-6">
        {detail.status === "idle" && (
          <div className="text-sm text-sivru-mute">Pick a run on the left.</div>
        )}
        {detail.status === "loading" && (
          <div className="text-sm text-sivru-mute">loading run…</div>
        )}
        {detail.status === "error" && (
          <div className="text-sm text-red-400">{detail.message}</div>
        )}
        {detail.status === "ready" && <RunDetail data={detail.data} />}
      </section>
    </main>
  );
}

// ───────────────────────────── run detail ──────────────────────────────

function RunDetail({ data }: { data: BenchRunDetail }): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-medium tracking-tight text-sivru-text">
          {formatDate(data.startedAt)}
        </h2>
        <div className="mt-1 text-xs text-sivru-mute">
          sivru {data.sivruVersion} · node {data.node} · {data.platform}
          {data.argv.length > 0 ? (
            <>
              {" · "}
              <code className="rounded bg-sivru-panel px-1.5 py-0.5 text-[11px] text-sivru-text">
                sivru {data.argv.join(" ")}
              </code>
            </>
          ) : null}
        </div>
      </header>

      {data.repos.length === 0 && (
        <div className="rounded-sivru border border-sivru-border bg-sivru-panel px-4 py-3 text-sm text-sivru-mute">
          No repos were benchmarked in this run.
        </div>
      )}

      {data.repos.map((repo) => (
        <RepoBlock key={repo.basename} repo={repo} />
      ))}
    </div>
  );
}

function RepoBlock({ repo }: { repo: BenchRunRepo }): JSX.Element {
  // x-axis range for "% saved" bars — shared across rows so they're
  // visually comparable. Clamp at 100 even though savings could exceed
  // it numerically; the chart loses its anchor otherwise.
  const maxSavings = useMemo(() => {
    let m = 0;
    for (const model of repo.models) {
      m = Math.max(m, model.ci.p95);
    }
    return Math.max(20, Math.ceil(m / 10) * 10);
  }, [repo.models]);

  // Number of queries that had ground-truth files (and thus can be
  // scored on recall/MRR). We treat the first model's count as
  // representative — all models score against the same query set.
  const scoreableCount =
    repo.models[0]?.queriesScoredForRecall ??
    (repo.queryDetails ?? []).filter((q) => q.relevantFiles.length > 0).length;

  const fromSearchCount = (repo.queryDetails ?? []).filter(
    (q) => q.source === "search_call",
  ).length;

  return (
    <section className="rounded-sivru border border-sivru-border bg-sivru-panel">
      <div className="border-b border-sivru-border px-4 py-3">
        <div className="text-sm font-medium text-sivru-text">{repo.basename}</div>
        <div className="mt-0.5 text-xs text-sivru-mute">
          {repo.project} · {repo.sessionCount} session
          {repo.sessionCount === 1 ? "" : "s"} · {repo.queries.length} quer
          {repo.queries.length === 1 ? "y" : "ies"}
          {repo.queryDetails !== undefined && (
            <>
              {" · "}
              <span title="Queries from explicit sivru.search calls (vs. inferred from user messages)">
                {fromSearchCount} from sivru.search
              </span>
              {" · "}
              <span title="Queries scoreable for recall@5 / MRR (had follow-up edits)">
                {scoreableCount} with ground truth
              </span>
            </>
          )}
        </div>
      </div>
      <div className="p-4">
        {repo.models.length === 0 ? (
          <div className="text-xs text-sivru-mute">No model results recorded.</div>
        ) : (
          <ul className="space-y-4">
            {repo.models.map((m) => (
              <ModelRow key={m.model} model={m} maxSavings={maxSavings} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ModelRow({
  model,
  maxSavings,
}: {
  model: BenchRunModel;
  maxSavings: number;
}): JSX.Element {
  const lo = clamp(model.ci.p05, 0, maxSavings);
  const hi = clamp(model.ci.p95, 0, maxSavings);
  const mid = clamp(model.ci.p50, 0, maxSavings);
  const widthMid = (mid / maxSavings) * 100;
  const widthLo = (lo / maxSavings) * 100;
  const widthHi = (hi / maxSavings) * 100;

  // The new IR-correct metrics. `medianRecallAt5` etc are optional —
  // older bench runs (formatVersion=1, no ground-truth scoring) don't
  // emit them. Hide the recall row when absent so old runs render
  // exactly as before.
  const hasRecall =
    model.queriesScoredForRecall !== undefined &&
    model.queriesScoredForRecall > 0 &&
    model.medianRecallAt5 !== undefined;

  return (
    <li>
      <div className="flex items-baseline justify-between text-xs">
        <div>
          <span className="font-mono text-sivru-text">{model.model}</span>
          <span className="ml-2 text-sivru-mute">{model.label}</span>
        </div>
        <div className="font-mono text-sivru-text">
          {hasRecall ? (
            <>
              recall@5 {model.medianRecallAt5!.toFixed(2)}
              <span className="ml-1 text-sivru-mute">
                · MRR {(model.medianMRR ?? 0).toFixed(2)}
              </span>
            </>
          ) : (
            <>
              {model.ci.p50.toFixed(1)}%
              <span className="ml-1 text-sivru-mute">
                (90% CI {model.ci.p05.toFixed(1)}–{model.ci.p95.toFixed(1)}%)
              </span>
            </>
          )}
        </div>
      </div>

      {hasRecall && model.recallCI !== undefined && (
        <RecallBar
          recallCI={model.recallCI}
          medianRecall={model.medianRecallAt5 ?? 0}
        />
      )}

      <div className="mt-1.5 flex items-baseline justify-between text-[11px] text-sivru-mute">
        <span>
          tokens saved{" "}
          <span className="font-mono text-sivru-text">
            {(model.medianSavedPct ?? model.ci.p50).toFixed(1)}%
          </span>{" "}
          median ({model.ci.p05.toFixed(0)}–{model.ci.p95.toFixed(0)}% 90% CI)
        </span>
      </div>
      <div className="relative mt-1.5 h-2 rounded-full bg-sivru-bg">
        {/* p05–p95 light band */}
        <div
          className="absolute inset-y-0 rounded-full bg-sivru-amber/20"
          style={{
            left: `${widthLo}%`,
            width: `${Math.max(0, widthHi - widthLo)}%`,
          }}
        />
        {/* 0–p50 solid */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-sivru-amber"
          style={{ width: `${widthMid}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-sivru-mute">
        <span>build {formatMs(model.buildMs)}</span>
        <span>search {formatMs(model.searchMs)}</span>
        <span>
          {model.perQuerySaved.length} queries
          {hasRecall && (
            <>
              {" · "}
              {model.queriesScoredForRecall} scored
            </>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * recall@5 bar: 0..1 axis. Solid fill from 0 to median, faded
 * extension from p05 to p95 so the uncertainty is visually obvious.
 * Higher is better (max 1.0 = every relevant file is in sivru's top 5).
 */
function RecallBar({
  recallCI,
  medianRecall,
}: {
  recallCI: { p05: number; p50: number; p95: number };
  medianRecall: number;
}): JSX.Element {
  const widthMid = clamp(medianRecall, 0, 1) * 100;
  const widthLo = clamp(recallCI.p05, 0, 1) * 100;
  const widthHi = clamp(recallCI.p95, 0, 1) * 100;
  return (
    <div className="relative mt-1.5 h-2 rounded-full bg-sivru-bg">
      <div
        className="absolute inset-y-0 rounded-full bg-sivru-amber/20"
        style={{
          left: `${widthLo}%`,
          width: `${Math.max(0, widthHi - widthLo)}%`,
        }}
      />
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-sivru-amber"
        style={{ width: `${widthMid}%` }}
      />
    </div>
  );
}

// ─────────────────────────── helpers ───────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return (
    d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
