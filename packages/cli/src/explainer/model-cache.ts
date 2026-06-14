// stateId-keyed cache for the explainer model (DESIGN-0018 Slice 1).
//
// Mirrors the symbol-index cache pattern: ~/.cache/sivru/explainer-models/
// <sha256(repoPath)>/<stateId>.json, atomic temp+rename write. The model is a
// pure function of repo state, so a stateId hit is always valid; a state change
// changes the stateId and naturally misses. Any cache error degrades to a
// rebuild — the cache is an optimization, never a correctness dependency.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ExplainerModel } from "./types.js";

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "explainer-models");
}

function repoSlug(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex");
}

/** stateId is a hex/safe string from computeStateId, but sanitize defensively. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

function entryPath(cacheDir: string, repoPath: string, stateId: string): string {
  return join(cacheDir, repoSlug(repoPath), `${sanitize(stateId)}.json`);
}

/** Load a cached model for (repoPath, stateId), or null on miss / any error. */
export async function loadModelCache(
  repoPath: string,
  stateId: string,
  cacheDir: string = defaultCacheDir(),
): Promise<ExplainerModel | null> {
  try {
    const raw = await readFile(entryPath(cacheDir, repoPath, stateId), "utf8");
    const model = JSON.parse(raw) as ExplainerModel;
    // Guard against a stale/forward-incompatible on-disk shape.
    if (model.schema !== 1 || model.stateId !== stateId) return null;
    return model;
  } catch {
    return null;
  }
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
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
    if (files.length === 0) return null;
    let newest: { file: string; mtimeMs: number } | null = null;
    for (const file of files) {
      const st = await stat(join(dir, file));
      if (newest === null || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
    }
    if (newest === null) return null;
    const model = JSON.parse(await readFile(join(dir, newest.file), "utf8")) as ExplainerModel;
    return model.schema === 1 ? model : null;
  } catch {
    return null;
  }
}

/** Write the model for (repoPath, stateId). Best-effort; swallows any error. */
export async function saveModelCache(
  model: ExplainerModel,
  cacheDir: string = defaultCacheDir(),
): Promise<void> {
  try {
    const target = entryPath(cacheDir, model.repoPath, model.stateId);
    await mkdir(join(cacheDir, repoSlug(model.repoPath)), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    await writeFile(tmp, JSON.stringify(model), "utf8");
    await rename(tmp, target); // atomic on the same filesystem
  } catch {
    // cache write failure is non-fatal — the model was already produced
  }
}
