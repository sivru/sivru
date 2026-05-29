// DESIGN-0021 slot 1 — the Blocks tab.
//
// Two sub-views over one repo's block graph: Issues (triage inbox, the
// default) and Graph (force-directed). A right-pane inspector shows the
// selected node's authored context + attached diagnostics, or scope counters
// when nothing is selected. Read-only: editing/feedback land in slot 2 behind
// --writable.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchBlocks, subscribeToBlocks } from "../api";
import type { BlockNodeDetail, BlocksResponse } from "../api";
import { BlockGraph } from "./BlockGraph";
import { BlockTriageInbox } from "./BlockTriageInbox";

export type BlocksViewProps = {
  /** Repo root, resolved by App (selectedProject → most-recent session root). */
  path: string | null;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: BlocksResponse }
  | { status: "error"; message: string };

type SubView = "issues" | "graph";

function countSeverities(data: BlocksResponse): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of data.diagnostics) {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
  }
  return { errors, warnings };
}

/** Degree-sorted node names (most-connected first) for J/K navigation. */
function degreeSorted(data: BlocksResponse): string[] {
  const deg = new Map<string, number>();
  for (const n of data.nodes) deg.set(n.name, 0);
  for (const e of data.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return [...data.nodes]
    .map((n) => n.name)
    .sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0) || a.localeCompare(b));
}

export function BlocksView({ path }: BlocksViewProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [subview, setSubview] = useState<SubView>("issues");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // SSE health: null = no stream yet; true = live; false = dropped.
  const [sseLive, setSseLive] = useState<boolean | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const inflight = useRef<symbol>(Symbol("idle"));
  // Guards against setState after unmount (the inflight Symbol only guards
  // against superseding loads, not teardown while a fetch is in flight).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback((p: string) => {
    const key = Symbol("load");
    inflight.current = key;
    setState({ status: "loading" });
    fetchBlocks(p)
      .then((data) => {
        if (!mounted.current || inflight.current !== key) return;
        setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!mounted.current || inflight.current !== key) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
  }, []);

  // Initial + path-change load.
  useEffect(() => {
    setSelected(null);
    setFilter("");
    if (path !== null && path.length > 0) load(path);
    else setState({ status: "idle" });
  }, [path, load]);

  // SSE live updates: refetch the graph on each block.updated; track health.
  useEffect(() => {
    if (path === null || path.length === 0) return;
    setSseLive(null);
    const handle = subscribeToBlocks(
      path,
      () => {
        setSseLive(true);
        load(path);
      },
      () => {
        setSseLive(false);
      },
    );
    return () => handle.close();
  }, [path, load]);

  const data = state.status === "ready" ? state.data : null;
  const selectedNode = useMemo<BlockNodeDetail | null>(() => {
    if (data === null || selected === null) return null;
    return data.nodes.find((n) => n.name === selected) ?? null;
  }, [data, selected]);

  // Map a diagnostic location → owning node name (range-contains match).
  const nodeNameAt = useCallback(
    (filePath: string, line: number): string | null => {
      if (data === null) return null;
      const n = data.nodes.find(
        (nd) =>
          nd.filePath === filePath &&
          line >= nd.range.startLine &&
          line <= nd.range.endLine,
      );
      return n?.name ?? null;
    },
    [data],
  );

  // Keyboard: I/G sub-view, J/K node cycle, Esc deselect, / focus filter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") {
        if (typing) (e.target as HTMLElement).blur();
        else setSelected(null);
        return;
      }
      if (typing) return;
      if (e.key === "i" || e.key === "I") setSubview("issues");
      else if (e.key === "g" || e.key === "G") setSubview("graph");
      else if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if ((e.key === "j" || e.key === "k") && data !== null) {
        const order = degreeSorted(data);
        if (order.length === 0) return;
        const cur = selected === null ? -1 : order.indexOf(selected);
        let next: number;
        if (cur === -1) {
          // No (or stale) selection: J starts at the top, K at the bottom.
          next = e.key === "j" ? 0 : order.length - 1;
        } else {
          next = Math.min(order.length - 1, Math.max(0, cur + (e.key === "j" ? 1 : -1)));
        }
        setSelected(order[next] ?? null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, selected]);

  if (path === null || path.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-sivru-mute">
        <div className="max-w-md rounded border border-sivru-border bg-sivru-panel p-6 text-center">
          <div className="text-sivru-text">No project selected.</div>
          <p className="mt-2">
            Select a project in the sidebar, or run{" "}
            <code className="rounded bg-sivru-bg px-1 text-sivru-amber">sivru observe init</code>{" "}
            inside a repo to surface its blocks here.
          </p>
        </div>
      </main>
    );
  }

  const counts = data !== null ? countSeverities(data) : { errors: 0, warnings: 0 };

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/* Tab header: title + counts + sub-view toggle + filter */}
      <div className="flex items-center gap-3 border-b border-sivru-border bg-sivru-panel px-4 py-2 text-xs">
        <span className="font-mono text-sivru-mute">Blocks</span>
        <span className="text-sivru-mute">·</span>
        <span className="truncate font-mono text-sivru-text" title={path}>
          {path.split("/").slice(-2).join("/")}
        </span>
        {data !== null && (
          <span className="text-sivru-mute">
            · {data.nodes.length} blocks · {data.diagnostics.length} diagnostics
          </span>
        )}
        <nav className="ml-auto flex items-center gap-1" aria-label="Blocks sub-view">
          {(["issues", "graph"] as const).map((v) => {
            const active = subview === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={active}
                onClick={() => setSubview(v)}
                className={
                  "rounded-sivru border px-2 py-0.5 capitalize transition-colors " +
                  (active
                    ? "border-sivru-amber/40 bg-sivru-amber/15 text-sivru-amber"
                    : "border-transparent text-sivru-mute hover:text-sivru-text")
                }
                title={v === "issues" ? "Issues (I)" : "Graph (G)"}
              >
                {v}
              </button>
            );
          })}
        </nav>
        <input
          ref={filterRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter (/)"
          className="w-40 rounded-sivru border border-sivru-border bg-sivru-bg px-2 py-0.5 text-xs text-sivru-text placeholder:text-sivru-mute focus-visible:ring-2 focus-visible:ring-sivru-amber"
        />
      </div>

      {/* Loading / progress strip */}
      {state.status === "loading" && (
        <div className="flex items-center gap-2 border-b border-sivru-border bg-sivru-bg px-4 py-1.5 text-xs text-sivru-mute">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sivru-amber" />
          Computing block graph…
        </div>
      )}
      {/* Error banner */}
      {state.status === "error" && (
        <div className="flex items-center gap-3 border-b border-sivru-error/40 bg-sivru-error/10 px-4 py-2 text-xs text-sivru-error">
          <span>Failed to build graph: {state.message}</span>
          <button
            type="button"
            onClick={() => path !== null && load(path)}
            className="rounded-sivru border border-sivru-error/40 px-2 py-0.5 hover:bg-sivru-error/20"
          >
            Retry
          </button>
        </div>
      )}
      {/* SSE-disconnected strip (last-known graph stays on screen) */}
      {sseLive === false && state.status === "ready" && (
        <div className="border-b border-sivru-error/30 bg-sivru-error/5 px-4 py-1 text-[11px] text-sivru-error/90">
          Lost live updates · retrying…
        </div>
      )}

      {/* Body: graph/issues pane + inspector */}
      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-y-auto bg-sivru-bg">
          {data !== null &&
            (subview === "graph" ? (
              <BlockGraph
                nodes={data.nodes}
                edges={data.edges}
                selected={selected}
                onSelect={setSelected}
              />
            ) : (
              <BlockTriageInbox
                diagnostics={data.diagnostics}
                selectedNode={selected}
                nodeNameAt={nodeNameAt}
                onSelectNode={setSelected}
                filter={filter}
              />
            ))}
        </section>
        <aside className="w-[360px] shrink-0 overflow-y-auto border-l border-sivru-border bg-sivru-panel">
          <Inspector node={selectedNode} data={data} />
        </aside>
      </div>
    </main>
  );
}

// ---- inspector -----------------------------------------------------------

function Inspector({
  node,
  data,
}: {
  node: BlockNodeDetail | null;
  data: BlocksResponse | null;
}): JSX.Element {
  if (node === null) {
    // Scope counters + three most-recent diagnostics + one-line explainer.
    if (data === null) {
      return <div className="p-4 text-sm text-sivru-mute">Loading…</div>;
    }
    const { errors, warnings } = countSeverities(data);
    return (
      <div className="flex flex-col gap-3 p-4 text-sm">
        <div className="text-xs text-sivru-mute">
          {data.nodes.length} blocks · <span className="text-sivru-error">{errors} errors</span> ·{" "}
          <span className="text-sivru-warn">{warnings} warnings</span>
        </div>
        <div className="text-[12px] text-sivru-mute">
          Select a node to inspect, or filter the issues list.
        </div>
        {data.diagnostics.slice(0, 3).map((d, i) => (
          <div key={`${d.code}-${i}`} className="rounded border border-sivru-border bg-sivru-bg p-2 text-xs">
            <span className="font-mono text-sivru-text">{d.code}</span>{" "}
            <span className="text-sivru-mute">{d.message}</span>
          </div>
        ))}
      </div>
    );
  }

  const b = node.block;
  const editorUrl = `vscode://file/${node.filePath}:${node.range.startLine}`;
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div>
        <div className="font-mono text-base text-sivru-text">{node.name}</div>
        <a
          href={editorUrl}
          className="font-mono text-[11px] text-sivru-mute hover:text-sivru-text"
          title="Open in editor"
        >
          {node.filePath}:{node.range.startLine}
        </a>
      </div>

      {b !== null ? (
        <>
          <Field label="role" value={b.role} />
          <Field label="responsibility" value={b.responsibility} />
          {b.maturity !== null && <Field label="maturity" value={b.maturity} />}
          {b.collaborators.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-sivru-mute">collaborators</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {b.collaborators.map((c) => (
                  <span
                    key={c}
                    className="rounded-sivru border border-sivru-border bg-sivru-bg px-1.5 py-0.5 font-mono text-[11px] text-sivru-text"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
          {b.invariantsV2.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-sivru-mute">invariants</div>
              <ul className="mt-1 space-y-1 text-[12px]">
                {b.invariantsV2.map((inv, i) => (
                  <li key={i} className="text-sivru-text">
                    {inv.rule}
                    {inv.enforcedBy !== null && (
                      <span className="ml-1 font-mono text-[11px] text-sivru-mute">
                        ↳ {inv.enforcedBy}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {b.decisions.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-sivru-mute">decisions</div>
              <ul className="mt-1 space-y-2 text-[12px]">
                {b.decisions.map((d, i) => (
                  <li key={i} className="text-sivru-text">
                    <span className="text-sivru-amber">chose</span> {d.chose}
                    <div className="text-sivru-mute">
                      <span className="text-sivru-amber">because</span> {d.because}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="rounded border border-sivru-error/40 bg-sivru-error/10 p-2 text-xs text-sivru-error">
          Block could not be parsed.
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wide text-sivru-mute">
          diagnostics ({node.diagnostics.length})
        </div>
        {node.diagnostics.length === 0 ? (
          <div className="mt-1 text-[12px] text-sivru-mute">No findings.</div>
        ) : (
          <ul className="mt-1 space-y-1">
            {node.diagnostics.map((d, i) => (
              <li key={`${d.code}-${i}`} className="flex items-start gap-2 text-[12px]">
                <span
                  className={
                    "mt-1 inline-block h-2 w-2 shrink-0 rounded-full " +
                    (d.severity === "error" ? "bg-sivru-error" : "bg-sivru-warn")
                  }
                  aria-hidden
                />
                <span>
                  <span className="font-mono text-sivru-mute">{d.code}</span>{" "}
                  <span className="text-sivru-text">{d.message}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-sivru-mute">{label}</div>
      <div className="mt-0.5 text-[13px] text-sivru-text">{value}</div>
    </div>
  );
}
