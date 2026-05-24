// Checkup tab — DESIGN-0005 §7.
//
// Lists findings grouped by file, with severity sort (error → warning →
// info) within each group per design-D1. Files-without-findings collapse
// to the bottom. Partial-result rendering: unreadable files show with a
// "Skipped: cannot read" badge.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchCheckup } from "../api";
import type {
  CheckupFinding,
  CheckupMemoryFile,
  CheckupReport,
  CheckupSeverity,
} from "../api";

export type CheckupViewProps = {
  /** Path read from App's selectedProject; fallback to the most-recent
   *  session's projectRoot when null. Empty-state shown when both
   *  are unavailable. */
  path: string | null;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: CheckupReport; fetchedAtMs: number }
  | { status: "error"; message: string; code?: string };

const SEVERITY_DOT: Record<CheckupSeverity, string> = {
  info: "bg-zinc-400",
  warning: "bg-amber-400",
  error: "bg-red-500",
};

const SEVERITY_RANK: Record<CheckupSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function CheckupView({ path }: CheckupViewProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "idle" });
  // Per design §7: latest fetch wins. We track an in-flight key so
  // stale responses can be discarded if the user changes path or
  // clicks Refresh mid-load.
  const inflightKey = useRef<symbol>(Symbol("idle"));

  const load = useCallback(
    (p: string) => {
      const key = Symbol("load");
      inflightKey.current = key;
      setState({ status: "loading" });
      fetchCheckup(p)
        .then((data) => {
          if (inflightKey.current !== key) return;
          setState({ status: "ready", data, fetchedAtMs: Date.now() });
        })
        .catch((err: unknown) => {
          if (inflightKey.current !== key) return;
          const m = err instanceof Error ? err.message : String(err);
          // Try to extract a SIVRU-Exxx code from the message for the
          // error-state banner.
          const codeMatch = /SIVRU-E\d+/.exec(m);
          setState({
            status: "error",
            message: m,
            ...(codeMatch !== null ? { code: codeMatch[0] } : {}),
          });
        });
    },
    [],
  );

  useEffect(() => {
    if (path !== null && path.length > 0) load(path);
    else setState({ status: "idle" });
  }, [path, load]);

  const refresh = useCallback(() => {
    if (path !== null && path.length > 0) load(path);
  }, [path, load]);

  if (path === null || path.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 flex-col p-6 text-sm text-sivru-mute">
        <div className="rounded border border-sivru-border bg-sivru-panel p-6">
          <div className="text-sivru-text">No project selected.</div>
          <p className="mt-2">
            Select a project in the sidebar, or run{" "}
            <code className="rounded bg-sivru-bg px-1 text-sivru-amber">sivru observe init</code>{" "}
            inside a repo to surface it here.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col p-4 text-sm">
      <div className="mb-3 flex items-baseline gap-3 text-xs text-sivru-mute">
        <span className="font-mono text-sivru-text">{path}</span>
        <button
          type="button"
          onClick={refresh}
          aria-busy={state.status === "loading"}
          className="rounded-sivru border border-sivru-border px-2 py-0.5 text-sivru-mute hover:text-sivru-text focus-visible:ring-2 focus-visible:ring-zinc-400"
        >
          {state.status === "loading" ? "Refreshing…" : "Refresh"}
        </button>
        {state.status === "ready" && (
          <span aria-live="polite">{formatFetchLabel(state.fetchedAtMs)}</span>
        )}
      </div>

      {state.status === "loading" && (
        <div className="flex items-center gap-2 rounded border border-sivru-border bg-sivru-panel p-3 text-sivru-mute">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sivru-mute" />
          Loading checkup…
        </div>
      )}

      {state.status === "error" && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-red-300">
          <div className="font-medium">{state.code ?? "Checkup failed"}</div>
          <div className="mt-1 text-xs text-red-300/80">{state.message}</div>
        </div>
      )}

      {state.status === "ready" && <ReportBody report={state.data} />}
    </main>
  );
}

function ReportBody({ report }: { report: CheckupReport }): JSX.Element {
  const grouped = useMemo(() => groupFindings(report), [report]);
  const withFindings = grouped.withFindings;
  const noFindings = grouped.noFindings;
  const unreadable = grouped.unreadable;

  const [showClean, setShowClean] = useState<boolean>(false);

  return (
    <div className="flex flex-col gap-3">
      {report.diagnostics.length > 0 && (
        <div className="rounded border border-zinc-400/30 bg-zinc-400/10 p-3 text-xs text-sivru-mute">
          {report.diagnostics.map((d) => (
            <div key={d.code + d.message}>
              <span className="font-mono text-sivru-text">{d.code}</span>{" "}
              {d.message}
            </div>
          ))}
        </div>
      )}

      {withFindings.length === 0 && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-300">
          Everything checked, nothing aged or dead.
        </div>
      )}

      {withFindings.map((g) => (
        <FileGroup key={g.file.path} file={g.file} findings={g.findings} />
      ))}

      {(noFindings.length > 0 || unreadable.length > 0) && (
        <div className="rounded border border-sivru-border bg-sivru-panel">
          <button
            type="button"
            onClick={() => setShowClean((s) => !s)}
            aria-expanded={showClean}
            className="flex w-full items-center justify-between px-3 py-2 text-xs text-sivru-mute hover:text-sivru-text"
          >
            <span>
              {noFindings.length + unreadable.length} files without findings
            </span>
            <span className="ml-2">{showClean ? "▾" : "▸"}</span>
          </button>
          {showClean && (
            <ul className="border-t border-sivru-border px-3 py-2 text-xs">
              {noFindings.map((f) => (
                <li key={f.path} className="font-mono text-sivru-mute">
                  {f.displayPath}
                </li>
              ))}
              {unreadable.map((f) => (
                <li
                  key={f.path}
                  className="font-mono italic text-zinc-400"
                >
                  {f.displayPath}{" "}
                  <span className="not-italic rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-200">
                    Skipped: cannot read
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function FileGroup({
  file,
  findings,
}: {
  file: CheckupMemoryFile;
  findings: CheckupFinding[];
}): JSX.Element {
  return (
    <div className="rounded border border-sivru-border bg-sivru-panel">
      <div className="border-b border-sivru-border px-3 py-2 font-mono text-xs text-sivru-text">
        {file.displayPath}
      </div>
      <ul role="table">
        {findings.map((f, i) => (
          <FindingRow key={`${f.checkId}-${f.line ?? "all"}-${i}`} f={f} />
        ))}
      </ul>
    </div>
  );
}

function FindingRow({ f }: { f: CheckupFinding }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li role="row" className="border-b border-sivru-border/50 px-3 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          role="cell"
          aria-label={f.severity}
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[f.severity]}`}
        />
        <div className="min-w-0 flex-1 text-xs">
          <span className="text-sivru-mute">{f.checkId}</span>
          {f.line !== undefined && (
            <span className="ml-1 text-sivru-mute">:{f.line}</span>
          )}
          <div className="mt-0.5 text-sivru-text">{f.summary}</div>
          {f.detail !== undefined && f.detail.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="mt-1 text-[10px] uppercase tracking-wide text-sivru-mute hover:text-sivru-text"
              >
                {open ? "▾ Hide detail" : "▸ Show detail"}
              </button>
              {open && (
                <div className="mt-1 rounded bg-sivru-bg px-2 py-1 text-xs text-sivru-mute">
                  {f.detail}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export interface Grouped {
  withFindings: Array<{ file: CheckupMemoryFile; findings: CheckupFinding[] }>;
  noFindings: CheckupMemoryFile[];
  unreadable: CheckupMemoryFile[];
}

export function groupFindings(report: CheckupReport): Grouped {
  const byPath = new Map<string, CheckupFinding[]>();
  for (const f of report.findings) {
    const arr = byPath.get(f.filePath) ?? [];
    arr.push(f);
    byPath.set(f.filePath, arr);
  }
  const withFindings: Grouped["withFindings"] = [];
  const noFindings: CheckupMemoryFile[] = [];
  const unreadable: CheckupMemoryFile[] = [];
  // Use the report's file list as the canonical order — repo files
  // first, then home-global per the load.ts sort.
  for (const file of report.files) {
    if (file.unreadable === true) {
      unreadable.push(file);
      continue;
    }
    const fs = byPath.get(file.path);
    if (fs === undefined || fs.length === 0) {
      noFindings.push(file);
      continue;
    }
    const sorted = fs.slice().sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    withFindings.push({ file, findings: sorted });
  }
  return { withFindings, noFindings, unreadable };
}

function formatFetchLabel(thenMs: number): string {
  const dt = Math.max(0, Date.now() - thenMs);
  if (dt < 5_000) return "Just fetched";
  if (dt < 60_000) return `Fetched ${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `Fetched ${Math.floor(dt / 60_000)}m ago`;
  return `Fetched ${Math.floor(dt / 3_600_000)}h ago`;
}
