// Where the money is (DESIGN-0023 Slice 2). Rank nodes by `derived.hotScore`
// (churn × coupling, computed in model.ts) so both the HTML System page's
// Attention panel and the `--diff` hot-spot context draw from ONE ranking — a
// change that lands on a hot node is the change worth reading first.

import type { NodeRef } from "./diff-types.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

export interface HotNode {
  ref: NodeRef;
  hotScore: number;
  churn: number;
  /** in+out degree (module/package) or collaborator count (symbol). */
  coupling: number;
}

const refOf = (n: ExplainerNode): NodeRef => ({ id: n.id, level: n.level, name: n.name, path: n.path });

const couplingOf = (n: ExplainerNode, inDegree: Map<string, number>): number =>
  n.level === "symbol"
    ? n.derived.collaborators.length
    : n.derived.depEdges.length + (inDegree.get(n.id) ?? 0);

/**
 * The top-N hot nodes across the whole tree (system root excluded — it is not a
 * place you edit). Ties break by churn then id so the order is stable across
 * runs. Nodes with hotScore 0 are dropped: a hot-spot list of cold nodes is noise.
 */
export function topHotNodes(model: ExplainerModel, limit = 8): HotNode[] {
  const inDegree = new Map<string, number>();
  const all: ExplainerNode[] = [];
  const walk = (n: ExplainerNode): void => {
    for (const to of n.derived.depEdges) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    if (n.level !== "system") all.push(n);
    for (const c of n.children) walk(c);
  };
  walk(model.root);

  return all
    .map((n) => ({
      ref: refOf(n),
      hotScore: n.derived.hotScore ?? n.derived.churn * couplingOf(n, inDegree),
      churn: n.derived.churn,
      coupling: couplingOf(n, inDegree),
    }))
    .filter((h) => h.hotScore > 0)
    .sort((a, b) => b.hotScore - a.hotScore || b.churn - a.churn || a.ref.id.localeCompare(b.ref.id))
    .slice(0, limit);
}
