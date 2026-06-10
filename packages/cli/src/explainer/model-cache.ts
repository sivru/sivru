// stateId-keyed cache for the explainer model (DESIGN-0018 Slice 1).
//
// Mirrors the symbol-index cache pattern: ~/.cache/sivru/explainer-models/
// <sha256(repoPath)>/<stateId>.json, atomic temp+rename write. The model is a
// pure function of repo state, so a stateId hit is always valid; a state change
// changes the stateId and naturally misses. Any cache error degrades to a
// rebuild — the cache is an optimization, never a correctness dependency.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
