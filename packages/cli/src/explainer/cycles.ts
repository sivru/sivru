// Dependency-cycle detection for the architectural diff (DESIGN-0023 Slice 1).
//
// The input is the module/package dependency graph the ExplainerModel already
// computes: each node's `derived.depEdges` is the sorted list of OTHER node ids
// it imports from. A cycle is a strongly-connected component (Tarjan) of size
// > 1, or a single node with a self-edge. `newCycles` reports only the cycles
// present at head but not at base — the structural regression a change introduced.
//
// Honesty (DESIGN-0023): this is the PARSED-IMPORT graph at MODULE granularity.
// Edges from unparsed files (JSON, generated, dynamic imports) are invisible,
// and a single-module repo can't form a module cycle. v0.14 reports cycles as
// informational; it does not gate on them.

import type { CycleDelta, DepEdge } from "./diff-types.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

/** Adjacency: node id → the ids it depends on. */
export type DepGraph = Map<string, string[]>;

/** Build a DepGraph from (id, depEdges) pairs — only edges whose target is also a node. */
export function buildDepGraph(nodes: { id: string; depEdges: string[] }[]): DepGraph {
  const ids = new Set(nodes.map((n) => n.id));
  const g: DepGraph = new Map();
  for (const n of nodes) {
    // Keep only edges to known nodes; a dep on a non-node target can't be in a cycle.
    g.set(n.id, n.depEdges.filter((t) => ids.has(t) && t !== n.id));
  }
  return g;
}

/**
 * Tarjan's strongly-connected-components. Returns only SCCs that are real
 * cycles: size > 1, or a single node that depends on itself.
 */
export function findCycleGroups(graph: DepGraph): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  // Iterative Tarjan (explicit stack) so a deep graph can't overflow the call stack.
  for (const root of graph.keys()) {
    if (idx.has(root)) continue;
    const work: { node: string; i: number }[] = [{ node: root, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame.node;
      if (frame.i === 0) {
        idx.set(v, index);
        low.set(v, index);
        index += 1;
        stack.push(v);
        onStack.add(v);
      }
      const neighbors = graph.get(v) ?? [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i]!;
        frame.i += 1;
        if (!idx.has(w)) {
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            if (w === v) break;
          }
          const selfLoop = comp.length === 1 && (graph.get(comp[0]!) ?? []).includes(comp[0]!);
          if (comp.length > 1 || selfLoop) sccs.push(comp.sort());
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!.node;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
      }
    }
  }
  return sccs;
}

/** Stable key for a cycle (its member set). */
function cycleKey(members: string[]): string {
  return members.join("|");
}

/**
 * All node ids that participate in SOME dependency cycle in the model (static —
 * every cycle at HEAD, not just new ones). Drives the `↻ in a cycle` badge on
 * the static System page. Nodes with no out-edges can't be in a cycle, so only
 * dep-bearing nodes seed the graph.
 */
export function cycleMemberIds(model: ExplainerModel): Set<string> {
  const nodes: { id: string; depEdges: string[] }[] = [];
  const walk = (n: ExplainerNode): void => {
    if (n.derived.depEdges.length > 0) nodes.push({ id: n.id, depEdges: n.derived.depEdges });
    n.children.forEach(walk);
  };
  walk(model.root);
  const out = new Set<string>();
  for (const group of findCycleGroups(buildDepGraph(nodes))) for (const id of group) out.add(id);
  return out;
}

/** Canonical render: the sorted members as a ring, deterministic across runs. */
function renderCycle(members: string[]): string {
  return `${members.join(" → ")} → ${members[0]}`;
}

/**
 * Cycles present at head but not at base. For each, identify the edge that
 * closed it: an edge present in head, absent in base, with both endpoints in
 * the cycle (the lex-smallest such edge, for determinism).
 */
export function newCycles(base: DepGraph, head: DepGraph): CycleDelta[] {
  const baseKeys = new Set(findCycleGroups(base).map(cycleKey));
  const fresh = findCycleGroups(head).filter((c) => !baseKeys.has(cycleKey(c)));

  return fresh.map((members) => {
    const memberSet = new Set(members);
    const candidates: DepEdge[] = [];
    for (const from of members) {
      const baseTargets = new Set(base.get(from) ?? []);
      for (const to of head.get(from) ?? []) {
        if (memberSet.has(to) && !baseTargets.has(to)) candidates.push({ from, to });
      }
    }
    candidates.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
    return { members, render: renderCycle(members), closedBy: candidates[0] ?? null };
  });
}
