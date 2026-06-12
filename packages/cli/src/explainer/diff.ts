// diffModels — the architectural delta of a change (DESIGN-0023 Slice 1).
//
// A PURE function over two ExplainerModels (base + head). The orchestration that
// builds the base model from a git worktree lives elsewhere (diff-worktree.ts);
// this file is the testable heart.
//
//   base model ─┐
//               ├─► diffModels ─► ArchDelta { nodes, edges, cycles, blocks, churn }
//   head model ─┘
//
// "changed" is STRUCTURAL only (exports / depEdges / collaborators / block) —
// churn is excluded (it shifts on nearly every node between base and head) and
// reported separately. Cycles use the module-level depEdges graph; see cycles.ts
// for the parsed-import / module-granularity honesty caveats.

import { buildDepGraph, newCycles } from "./cycles.js";
import type { ArchDelta, ChangedNode, ChurnDelta, DepEdge, NodeRef } from "./diff-types.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

function flatten(model: ExplainerModel): Map<string, ExplainerNode> {
  const m = new Map<string, ExplainerNode>();
  const walk = (n: ExplainerNode): void => {
    m.set(n.id, n);
    for (const c of n.children) walk(c);
  };
  walk(model.root);
  return m;
}

const ref = (n: ExplainerNode): NodeRef => ({ id: n.id, level: n.level, name: n.name, path: n.path });
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const byId = (a: NodeRef, b: NodeRef): number => a.id.localeCompare(b.id);

/** Which STRUCTURAL fields differ between two versions of the same node. Never churn. */
function changedFields(a: ExplainerNode, b: ExplainerNode): string[] {
  const f: string[] = [];
  if (!eq(a.derived.exports, b.derived.exports)) f.push("exports");
  if (!eq(a.derived.depEdges, b.derived.depEdges)) f.push("depEdges");
  if (!eq(a.derived.collaborators, b.derived.collaborators)) f.push("collaborators");
  if ((a.blockHash ?? null) !== (b.blockHash ?? null)) f.push("block");
  return f;
}

/** Module/package dependency edges as a `from\tto` string set. */
function edgeSet(nodes: Map<string, ExplainerNode>): Set<string> {
  const s = new Set<string>();
  for (const n of nodes.values()) {
    if (n.level === "module" || n.level === "package") {
      for (const to of n.derived.depEdges) s.add(`${n.id}\t${to}`);
    }
  }
  return s;
}

const parseEdge = (e: string): DepEdge => {
  const [from, to] = e.split("\t");
  return { from: from!, to: to! };
};

export function diffModels(base: ExplainerModel, head: ExplainerModel, baseRef: string): ArchDelta {
  const B = flatten(base);
  const H = flatten(head);

  const added: NodeRef[] = [];
  const removed: NodeRef[] = [];
  const changed: ChangedNode[] = [];
  const blocksAdded: NodeRef[] = [];
  const blocksRemoved: NodeRef[] = [];
  const blocksChanged: NodeRef[] = [];
  const churn: ChurnDelta[] = [];

  for (const [id, h] of H) {
    const b = B.get(id);
    if (b === undefined) {
      added.push(ref(h));
      if (h.block) blocksAdded.push(ref(h));
      continue;
    }
    const fields = changedFields(b, h);
    if (fields.length > 0) changed.push({ ref: ref(h), fields });
    // block presence / content
    if (!b.block && h.block) blocksAdded.push(ref(h));
    else if (b.block && !h.block) blocksRemoved.push(ref(h));
    else if (b.block && h.block && (b.blockHash ?? "") !== (h.blockHash ?? "")) blocksChanged.push(ref(h));
    // churn — reported separately, never a "change"
    if (b.derived.churn !== h.derived.churn) {
      churn.push({ ref: ref(h), base: b.derived.churn, head: h.derived.churn });
    }
  }
  for (const [id, b] of B) {
    if (!H.has(id)) {
      removed.push(ref(b));
      if (b.block) blocksRemoved.push(ref(b));
    }
  }

  const be = edgeSet(B);
  const he = edgeSet(H);
  const edgesAdded = [...he].filter((e) => !be.has(e)).sort().map(parseEdge);
  const edgesRemoved = [...be].filter((e) => !he.has(e)).sort().map(parseEdge);

  const moduleNodes = (m: Map<string, ExplainerNode>): { id: string; depEdges: string[] }[] =>
    [...m.values()].filter((n) => n.level === "module").map((n) => ({ id: n.id, depEdges: n.derived.depEdges }));
  const cycles = { added: newCycles(buildDepGraph(moduleNodes(B)), buildDepGraph(moduleNodes(H))) };

  return {
    baseRef,
    nodes: { added: added.sort(byId), removed: removed.sort(byId), changed: changed.sort((a, b) => byId(a.ref, b.ref)) },
    edges: { added: edgesAdded, removed: edgesRemoved },
    cycles,
    blocks: { added: blocksAdded.sort(byId), removed: blocksRemoved.sort(byId), changed: blocksChanged.sort(byId) },
    churn: churn.sort((a, b) => byId(a.ref, b.ref)),
  };
}
