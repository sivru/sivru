// Serve-stale model + health for the agent map (DESIGN-0024 T6). Shared by the
// MCP `map` tool and the `sivru map` CLI mirror so both serve the SAME slice.
//
// `map` is called liberally mid-task, often on the very repo being edited — so a
// full model rebuild per call (the working tree changes the stateId) is cache
// thrash exactly when the tool is used. Instead: a cache hit on the current
// stateId is fresh; a miss serves the last cached model marked stale (the rebuild
// is lazy, never inline); only a genuine cold start builds once. Health is cached
// under the SERVED model's stateId, so liberal calls stay sub-build after warm.

import { computeStateId } from "@sivru/search";

import { buildModelHealth, type ModelHealth } from "./health.js";
import { loadHealthCache, saveHealthCache } from "./health-cache.js";
import { projectModel } from "./model.js";
import { loadModelCache, loadNewestModelCache } from "./model-cache.js";
import type { ExplainerModel } from "./types.js";

/** A legible staleness marker — not a raw hash (DESIGN-0024 DX review). */
export interface FreshAsOf {
  /** The HEAD short-sha (or stateId prefix) the served model reflects. */
  sha: string;
  /** Was the served model built from a dirty working tree? */
  dirty: boolean;
  /** Has the working tree changed since the served model was built? */
  stale: boolean;
  /** One-line, reader-actionable meaning — legible to a second agent / post-compaction. */
  note: string;
}

export interface ServedModel {
  model: ExplainerModel;
  health: ModelHealth;
  freshAsOf: FreshAsOf;
}

export interface LoadModelAndHealthOptions {
  /** Override both cache directories (tests). */
  modelCacheDir?: string;
  healthCacheDir?: string;
}

// In-flight de-dup for the production path: two concurrent first-ever `map`
// calls on a cold repo would otherwise both run `projectModel` (the symbol-index
// layer dedups its build, but this projection does not). Share the promise while
// it is pending and drop it on settle, so a later call still recomputes
// freshAsOf. Skipped when custom cache dirs are passed (tests run in parallel
// with independent fixtures).
const inFlight = new Map<string, Promise<ServedModel>>();

export async function loadModelAndHealth(
  absRepo: string,
  opts: LoadModelAndHealthOptions = {},
): Promise<ServedModel> {
  const dedup = opts.modelCacheDir === undefined && opts.healthCacheDir === undefined;
  if (dedup) {
    const existing = inFlight.get(absRepo);
    if (existing !== undefined) return existing;
    const p = loadModelAndHealthUncached(absRepo, opts);
    inFlight.set(absRepo, p);
    try {
      return await p;
    } finally {
      inFlight.delete(absRepo);
    }
  }
  return loadModelAndHealthUncached(absRepo, opts);
}

async function loadModelAndHealthUncached(
  absRepo: string,
  opts: LoadModelAndHealthOptions,
): Promise<ServedModel> {
  const currentStateId = await computeStateId(absRepo);
  let model = await loadModelCache(absRepo, currentStateId, opts.modelCacheDir);
  let stale = false;
  if (model === null) {
    const newest = await loadNewestModelCache(absRepo, opts.modelCacheDir);
    if (newest !== null) {
      model = newest;
      stale = true;
    } else {
      // Cold start — nothing to serve stale, so build once (and cache it).
      model = await projectModel(absRepo, opts.modelCacheDir !== undefined ? { cacheDir: opts.modelCacheDir } : {});
    }
  }

  let health = await loadHealthCache(absRepo, model.stateId, opts.healthCacheDir);
  if (health === null) {
    health = await buildModelHealth(model);
    await saveHealthCache(absRepo, health, opts.healthCacheDir);
  }

  // `dirty` describes the SERVED model (was it built from a dirty tree?), not the
  // current tree — a clean model served stale while the tree is now dirty is NOT
  // a dirty-built model. computeStateId encodes dirty as `<sha>:<diffhash>`.
  const dirty = model.stateId.includes(":");
  const at = model.head.length > 0 ? `HEAD@${model.head}` : model.stateId.slice(0, 12);
  const freshAsOf: FreshAsOf = {
    sha: model.head.length > 0 ? model.head : model.stateId.slice(0, 12),
    dirty,
    stale,
    note: stale
      ? `reflects ${at}; the working tree changed since this build — the slice may lag your latest edit by one orient call (rebuild is lazy)`
      : `current as of ${at}${dirty ? " (built from the dirty working tree)" : ""}`,
  };
  return { model, health, freshAsOf };
}
