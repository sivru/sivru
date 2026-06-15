// stateId-keyed cache for the explainer model (DESIGN-0018 Slice 1).
//
// Mirrors the symbol-index cache pattern: ~/.cache/sivru/explainer-models/
// <sha256(repoPath)>/<stateId>.json, atomic temp+rename write. The model is a
// pure function of repo state, so a stateId hit is always valid; a state change
// changes the stateId and naturally misses. Any cache error degrades to a
// rebuild — the cache is an optimization, never a correctness dependency.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { entryPath, repoSlug, sanitizeStateId } from "./cache-paths.js";
import type { ExplainerModel } from "./types.js";

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "explainer-models");
}

// A small pointer file naming the most-recently-written model, so the serve-stale
// fast path (loadNewestModelCache) is one readFile, not an O(files) mtime scan.
// Named without a `.json` suffix so it is invisible to the model-file scan/prune.
const POINTER_FILE = "latest";
// Cap per-repo model files: active editing mints a new stateId per working-tree
// change, so without a bound the cache dir grows unboundedly. Keep the N newest.
const MODEL_CACHE_KEEP = 8;

function tmpSuffix(): string {
  return `tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
}

async function readModelFile(path: string): Promise<ExplainerModel | null> {
  try {
    const model = JSON.parse(await readFile(path, "utf8")) as ExplainerModel;
    return model.schema === 1 ? model : null;
  } catch {
    return null;
  }
}

/** Load a cached model for (repoPath, stateId), or null on miss / any error. */
export async function loadModelCache(
  repoPath: string,
  stateId: string,
  cacheDir: string = defaultCacheDir(),
): Promise<ExplainerModel | null> {
  const model = await readModelFile(entryPath(cacheDir, repoPath, stateId));
  // Guard against a stale/forward-incompatible on-disk shape (readModelFile
  // already checks schema; here we also bind the stateId for an exact hit).
  return model !== null && model.stateId === stateId ? model : null;
}

/**
 * The most recently written cached model for a repo, ANY stateId (DESIGN-0024,
 * T6 serve-stale). When the working tree changed since the last build, the
 * current stateId misses — rather than rebuild inline on the agent's hot path,
 * `map` serves this last-known model and marks it stale. Returns null when no
 * cache entry exists for the repo (a genuine cold start, which must build once).
 */
export async function loadNewestModelCache(
  repoPath: string,
  cacheDir: string = defaultCacheDir(),
): Promise<ExplainerModel | null> {
  try {
    const dir = join(cacheDir, repoSlug(repoPath));
    // Fast path: the `latest` pointer names the newest model written. One readFile
    // on the hot path instead of readdir + a stat() per cached stateId.
    try {
      const pointed = (await readFile(join(dir, POINTER_FILE), "utf8")).trim();
      // A pointer must be a bare filename in this dir (no traversal) ending .json.
      if (pointed.endsWith(".json") && !pointed.includes("/") && !pointed.includes("\\")) {
        const model = await readModelFile(join(dir, pointed));
        if (model !== null) return model;
      }
    } catch {
      // No pointer (cache predates it, or a write lost the race) → scan fallback.
    }
    // Fallback: newest `.json` by mtime — back-compat for caches without a pointer.
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
    let newest: { file: string; mtimeMs: number } | null = null;
    for (const file of files) {
      const st = await stat(join(dir, file));
      if (newest === null || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
    }
    return newest === null ? null : readModelFile(join(dir, newest.file));
  } catch {
    return null;
  }
}

/** Best-effort: point `latest` at the just-written model file (atomic rename). */
async function writePointer(dir: string, filename: string): Promise<void> {
  try {
    const target = join(dir, POINTER_FILE);
    const tmp = `${target}.${tmpSuffix()}`;
    await writeFile(tmp, filename, "utf8");
    await rename(tmp, target);
  } catch {
    // a missing/stale pointer only costs loadNewestModelCache its fast path
  }
}

/** Best-effort: keep only the MODEL_CACHE_KEEP newest model files in `dir`. */
async function pruneOldModels(dir: string): Promise<void> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
    if (files.length <= MODEL_CACHE_KEEP) return;
    const stamped = await Promise.all(
      files.map(async (f) => ({ f, mtimeMs: (await stat(join(dir, f))).mtimeMs })),
    );
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    await Promise.all(stamped.slice(MODEL_CACHE_KEEP).map(({ f }) => rm(join(dir, f), { force: true })));
  } catch {
    // pruning is housekeeping; a failure just leaves extra files on disk
  }
}

/** Write the model for (repoPath, stateId). Best-effort; swallows any error. */
export async function saveModelCache(
  model: ExplainerModel,
  cacheDir: string = defaultCacheDir(),
): Promise<void> {
  try {
    const dir = join(cacheDir, repoSlug(model.repoPath));
    await mkdir(dir, { recursive: true });
    const filename = `${sanitizeStateId(model.stateId)}.json`;
    const target = join(dir, filename);
    const tmp = `${target}.${tmpSuffix()}`;
    await writeFile(tmp, JSON.stringify(model), "utf8");
    await rename(tmp, target); // atomic on the same filesystem
    await writePointer(dir, filename); // fast-path index for serve-stale
    await pruneOldModels(dir); // bound growth under active editing
  } catch {
    // cache write failure is non-fatal — the model was already produced
  }
}
