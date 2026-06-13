// Presentation enrichment for the architectural diff (DESIGN-0023 Slice 2,
// follow-up). The raw ArchDelta leads with the highest-signal structural deltas
// (cycles, edges, @sivru blocks), but on a large change the BULK — hundreds of
// added symbols, a new subsystem, the high-traffic spots the change landed on —
// collapses into a single count. This derives two human-facing views over the
// delta so text / markdown / HTML can show the actual footprint:
//
//   surface  — where new code landed: added modules/packages by name, and added
//              symbols bucketed by the module they belong to.
//   hotspots — touched (added/changed) symbols ranked by hotScore (churn ×
//              coupling): "this change landed on these high-traffic spots"
//              (the M-A hot-spot context the design specified for the diff).
//
// Pure derivation over the delta + the HEAD model; never mutates either, and is
// NOT part of the JSON contract (the ArchDelta wire shape stays locked).

import type { ArchDelta, NodeRef } from "./diff-types.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

export interface SurfaceArea {
  addedModules: NodeRef[];
  addedPackages: NodeRef[];
  /** Added symbols grouped by the module they live under, most first. */
  addedSymbolsByModule: { module: string; count: number }[];
  addedSymbolTotal: number;
  changedCount: number;
  removedCount: number;
}
export interface TouchedHotspot {
  ref: NodeRef;
  hotScore: number;
  churn: number;
  kind: "added" | "changed";
}
export interface DiffContext {
  surface: SurfaceArea;
  hotspots: TouchedHotspot[];
}

/** Derive the surface-area + hot-spot views for a delta against the HEAD model. */
export function buildDiffContext(head: ExplainerModel, delta: ArchDelta, hotLimit = 6): DiffContext {
  const byId = new Map<string, ExplainerNode>();
  const index = (n: ExplainerNode): void => {
    byId.set(n.id, n);
    n.children.forEach(index);
  };
  index(head.root);

  // Which module a path lives under (longest matching module path wins so a
  // nested new module beats its parent); fall back to the top path segment.
  const modules = head.root.children;
  const moduleOf = (path: string): string => {
    let best: ExplainerNode | null = null;
    for (const m of modules) {
      if (m.path === "") continue;
      if ((path === m.path || path.startsWith(`${m.path}/`)) && (best === null || m.path.length > best.path.length)) {
        best = m;
      }
    }
    return (best?.name ?? path.split("/")[0]) || "(root)"; // `||` so an empty top segment falls back too
  };

  const addedSymbols = delta.nodes.added.filter((n) => n.level === "symbol");
  const symCounts = new Map<string, number>();
  for (const n of addedSymbols) {
    const k = moduleOf(n.path);
    symCounts.set(k, (symCounts.get(k) ?? 0) + 1);
  }
  const addedSymbolsByModule = [...symCounts.entries()]
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));

  const surface: SurfaceArea = {
    addedModules: delta.nodes.added.filter((n) => n.level === "module"),
    addedPackages: delta.nodes.added.filter((n) => n.level === "package"),
    addedSymbolsByModule,
    addedSymbolTotal: addedSymbols.length,
    changedCount: delta.nodes.changed.length,
    removedCount: delta.nodes.removed.length,
  };

  // Hot-spots: every touched node (added or structurally changed) scored by the
  // model's hotScore; keep the hottest. Cold nodes (score 0 — e.g. a brand-new
  // low-churn file) drop out, so this surfaces the high-traffic code the change
  // actually disturbed.
  const touched: { ref: NodeRef; kind: "added" | "changed" }[] = [
    ...delta.nodes.added.map((ref) => ({ ref, kind: "added" as const })),
    ...delta.nodes.changed.map((c) => ({ ref: c.ref, kind: "changed" as const })),
  ];
  const hotspots = touched
    .map((t) => {
      const node = byId.get(t.ref.id);
      return { ref: t.ref, hotScore: node?.derived.hotScore ?? 0, churn: node?.derived.churn ?? 0, kind: t.kind };
    })
    .filter((h) => h.hotScore > 0)
    .sort((a, b) => b.hotScore - a.hotScore || b.churn - a.churn || a.ref.id.localeCompare(b.ref.id))
    .slice(0, hotLimit);

  return { surface, hotspots };
}
