// Shared filesystem-path helpers for the stateId-keyed explainer caches
// (model-cache.ts, health-cache.ts). Both caches live under
// ~/.cache/sivru/<area>/<repoSlug>/<stateId>.json; only the <area> differs, so
// the slug + filename logic is shared here rather than mirrored per file.

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/** sha256 of the absolute repo path — the per-repo cache subdirectory name. */
export function repoSlug(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex");
}

/** A stateId is already hex/safe from computeStateId, but sanitize defensively. */
export function sanitizeStateId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** <cacheDir>/<repoSlug>/<stateId>.json — the on-disk path for one cached entry. */
export function entryPath(cacheDir: string, repoPath: string, stateId: string): string {
  return join(cacheDir, repoSlug(repoPath), `${sanitizeStateId(stateId)}.json`);
}
