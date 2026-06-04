// Shared cache primitives used by both the search-chunk cache
// (packages/search/src/cache/index.ts) and the symbol-index cache
// (packages/search/src/explain/cache.ts).
//
// Keeping these in one module means a bug fix (e.g., a Windows UNC edge case
// in repoSlug or a sanitize regex change) lands for both caches at once.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Hash the *resolved* absolute repo path so two different cwds for the same
 * logical repo collide intentionally; different repos cannot.
 */
export function repoSlug(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex");
}

/** Build the per-repo directory inside a cache root. */
export function repoDir(cacheDir: string, repoPath: string): string {
  return join(cacheDir, repoSlug(repoPath));
}

/**
 * Strip characters that are invalid in NTFS filenames: `: < > " / \ | ? *`
 * State-ids include `:` (between sha and diff-hash, or after `mtime:`) so
 * we replace those with `__` here. POSIX filesystems are unaffected.
 */
export function sanitizeForFilename(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, "__");
}

/** True when the error is an ENOENT (missing file). */
export function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Best-effort unlink — never throws. */
export async function bestEffortUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    /* ignore */
  }
}
