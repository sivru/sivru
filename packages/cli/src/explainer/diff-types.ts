// The architectural delta of a change — the output of `diffModels` (DESIGN-0023
// Slice 1, the `--diff` report). Pure data: two ExplainerModels in, this out.
//
// v0.14 is REPORT-ONLY (no gate). Cycles are the parsed-import module graph and
// are labelled informational; the gate (and finer cycle granularity) land in
// v0.15 with the drift signal + a suppression baseline.

import type { ExplainerLevel } from "./types.js";

/** A node identified just enough to point a human/tool at it. */
export interface NodeRef {
  id: string;
  level: ExplainerLevel;
  name: string;
  path: string;
}

/** A node present in both models whose STRUCTURAL fields changed (never churn). */
export interface ChangedNode {
  ref: NodeRef;
  /** Which structural fields differ: "exports" | "depEdges" | "collaborators" | "block". */
  fields: string[];
}

/** A directed dependency edge between two module/package nodes (by id). */
export interface DepEdge {
  from: string;
  to: string;
}

/** A dependency cycle (a strongly-connected component) in the module graph. */
export interface CycleDelta {
  /** Member node ids, sorted. */
  members: string[];
  /** Canonical, deterministic render, e.g. "module:a → module:b → module:a". */
  render: string;
  /** The new edge (present at head, absent at base) that closed this cycle, if identifiable. */
  closedBy: DepEdge | null;
}

/** A node whose churn moved between base and head (reported separately, never a "change"). */
export interface ChurnDelta {
  ref: NodeRef;
  base: number;
  head: number;
}

/** The full architectural delta of a change. */
export interface ArchDelta {
  /** The base ref the head was diffed against. */
  baseRef: string;
  nodes: { added: NodeRef[]; removed: NodeRef[]; changed: ChangedNode[] };
  edges: { added: DepEdge[]; removed: DepEdge[] };
  /** New cycles only (present at head, absent at base). */
  cycles: { added: CycleDelta[] };
  blocks: { added: NodeRef[]; removed: NodeRef[]; changed: NodeRef[] };
  churn: ChurnDelta[];
}
