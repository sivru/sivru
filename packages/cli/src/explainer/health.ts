// Descriptive model health for the agent map (DESIGN-0024, T2).
//
// `map` is an MCP tool an agent calls LIBERALLY mid-task, so the three M-A health
// passes (hot / cycle / drift, DESIGN-0023) must not recompute per call — each is
// a whole-model pass and `staticDriftDetail` walks the repo resolving every
// `@sivru` enforced-by. We run all three ONCE per model build and cache the result
// under the same stateId key as the model (health-cache.ts). The first `map` call
// warms it; every later call is a map lookup.
//
// Honesty (inherited from DESIGN-0023): this is DESCRIPTIVE state — the target's
// CURRENT health — never a prediction about an edit `map` has not seen. The graph
// is the parsed-import graph at module granularity; dynamic/unparsed imports are
// invisible and a single-module repo has no module cycles.

import { cycleRenders } from "./cycles.js";
import { staticDriftDetail, type ResolveFn } from "./drift.js";
import { topHotNodes } from "./attention.js";
import type { ExplainerModel } from "./types.js";

/** How deep the repo attention ranking goes before a node counts as "not hot". */
export const HOT_RANK_LIMIT = 25;

/** The descriptive health of a single node — every field "all clear" by default. */
export interface NodeHealth {
  /** Present only when the node is in the repo's top-{HOT_RANK_LIMIT} attention list. */
  hot: { score: number; rank: number } | null;
  /** Present only when the node's module already sits in a dependency cycle. */
  inCycle: { render: string } | null;
  /** `@sivru` invariants whose enforced-by linkage does NOT resolve now. */
  driftBroken: { rule: string; enforcedBy: string; reason: string }[];
  /** Invariants with enforced-by: null — surfaced, never hidden. */
  unguardable: { rule: string }[];
}

/** The all-clear health used when a node has no signal. */
export function emptyNodeHealth(): NodeHealth {
  return { hot: null, inCycle: null, driftBroken: [], unguardable: [] };
}

/**
 * Whole-model health, computed once per build. Only nodes carrying SOME signal
 * appear in `byId`; a missing id means all-clear. Serialised verbatim into the
 * health cache, so it stays plain-JSON (no Maps/Sets on the wire).
 */
export interface ModelHealth {
  /** Wire-shape version; bump on any breaking change. */
  schema: 1;
  /** The stateId the parent model was built under (cache key + validity guard). */
  stateId: string;
  /** nodeId → its non-empty health. */
  byId: Record<string, NodeHealth>;
}

/**
 * Run the three M-A passes against a built model and fold them into one
 * per-node health map. The `resolve` hook is injectable for tests (drift);
 * production uses the repo-walking enforcement resolver.
 */
export async function buildModelHealth(
  model: ExplainerModel,
  resolve?: ResolveFn,
): Promise<ModelHealth> {
  const byId: Record<string, NodeHealth> = {};
  const ensure = (id: string): NodeHealth => (byId[id] ??= emptyNodeHealth());

  // hot — top-N attention ranking; rank is 1-indexed within the limit.
  const hot = topHotNodes(model, HOT_RANK_LIMIT);
  hot.forEach((h, i) => {
    ensure(h.ref.id).hot = { score: h.hotScore, rank: i + 1 };
  });

  // inCycle — the canonical render of the cycle each member sits in.
  for (const [id, render] of cycleRenders(model)) {
    ensure(id).inCycle = { render };
  }

  // driftBroken / unguardable — per-node detail from the one whole-repo pass.
  const drift = await staticDriftDetail(model, resolve);
  for (const [id, d] of drift) {
    const h = ensure(id);
    h.driftBroken = d.broken.map((b) => ({ rule: b.rule, enforcedBy: b.enforcedBy, reason: b.reason }));
    h.unguardable = d.unguardable.map((u) => ({ rule: u.rule }));
  }

  return { schema: 1, stateId: model.stateId, byId };
}

/** The health of one node, defaulting to all-clear when it carries no signal. */
export function healthOf(health: ModelHealth, nodeId: string): NodeHealth {
  return health.byId[nodeId] ?? emptyNodeHealth();
}
