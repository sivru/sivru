// stateId-keyed cache for the model health (DESIGN-0024, T2).
//
// Mirrors model-cache.ts exactly: ~/.cache/sivru/explainer-health/
// <sha256(repoPath)>/<stateId>.json, atomic temp+rename write. Health is a pure
// function of the model (which is a pure function of repo state), so a stateId hit
// is always valid; a state change moves the stateId and naturally misses. Any
// cache error degrades to a recompute — the cache is an optimization, never a
// correctness dependency.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ModelHealth } from "./health.js";

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "sivru", "explainer-health");
}

function repoSlug(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex");
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

function entryPath(cacheDir: string, repoPath: string, stateId: string): string {
  return join(cacheDir, repoSlug(repoPath), `${sanitize(stateId)}.json`);
}

/** Load cached health for (repoPath, stateId), or null on miss / any error. */
export async function loadHealthCache(
  repoPath: string,
  stateId: string,
  cacheDir: string = defaultCacheDir(),
): Promise<ModelHealth | null> {
  try {
    const raw = await readFile(entryPath(cacheDir, repoPath, stateId), "utf8");
    const health = JSON.parse(raw) as ModelHealth;
    if (health.schema !== 1 || health.stateId !== stateId) return null;
    return health;
  } catch {
    return null;
  }
}

/** Write health for (repoPath, stateId). Best-effort; swallows any error. */
export async function saveHealthCache(
  repoPath: string,
  health: ModelHealth,
  cacheDir: string = defaultCacheDir(),
): Promise<void> {
  try {
    const target = entryPath(cacheDir, repoPath, health.stateId);
    await mkdir(join(cacheDir, repoSlug(repoPath)), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    await writeFile(tmp, JSON.stringify(health), "utf8");
    await rename(tmp, target); // atomic on the same filesystem
  } catch {
    // cache write failure is non-fatal — the health was already produced
  }
}
