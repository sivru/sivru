// Per-file commitCount index (DESIGN-0004 D2 / T7).
//
// Walks the local git log ONCE per state_id and emits a `Map<filePath, count>`
// the symbol index consumes when populating `SymbolIndexEntry.commitCount`.
// This is the source of the design's "zero git per MCP request" property:
// the walk runs at index-build time, not at explain-request time.
//
// `since` is an optional window in days; the artifact layer's "churn"
// section uses 90 days by default — buildCommitCounts mirrors that so the
// commit count it reports matches the window the artifact reports.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SivruExplainError } from "./types.js";

const execFileAsync = promisify(execFile);

export type CommitCountsOptions = {
  /** Optional `--since=<n>.days` window. Omit for full history. */
  sinceDays?: number;
  /** Custom git binary path (mostly for tests). Defaults to "git". */
  gitBin?: string;
  /** Maximum git stdout bytes. Defaults to 64 MiB. */
  maxBuffer?: number;
};

/**
 * Build the per-file commit-count map for `repoPath` by streaming
 * `git log --name-only --pretty=format:` and counting occurrences. Empty
 * stdout (or a non-git tree) yields an empty map — buildSymbolIndex then
 * falls back to commitCount=0, which is the right default.
 *
 * Paths are emitted in POSIX form even on Windows (git normalises them).
 */
export async function buildCommitCounts(
  repoPath: string,
  opts: CommitCountsOptions = {},
): Promise<Map<string, number>> {
  const args = ["-C", repoPath, "log", "--name-only", "--pretty=format:"];
  if (opts.sinceDays !== undefined && opts.sinceDays > 0) {
    args.push(`--since=${opts.sinceDays}.days`);
  }
  const bin = opts.gitBin ?? "git";
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  let stdout: string;
  try {
    const result = await execFileAsync(bin, args, { maxBuffer });
    stdout = result.stdout;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SivruExplainError(
        "SIVRU-E2006",
        `git binary not found at "${bin}"`,
      );
    }
    // Not a git repo (exit 128) → empty map, not a hard error. The artifact
    // already documents the "non-git tree" case in its footer.
    const message = err instanceof Error ? err.message : String(err);
    if (/not a git repository/i.test(message) || /fatal: not a git repo/i.test(message)) {
      return new Map();
    }
    throw new SivruExplainError(
      "SIVRU-E2006",
      `git log failed in ${repoPath}: ${message}`,
    );
  }
  const counts = new Map<string, number>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * Lightweight per-process cache of commit-count maps keyed by
 * `(repoPath, stateId, sinceDays)`. Backs the MCP path so two explain
 * requests in the same session against the same state share the git walk.
 */
const inProcCache = new Map<string, Map<string, number>>();

export function cacheKey(
  repoPath: string,
  stateId: string,
  sinceDays: number | undefined,
): string {
  return `${repoPath}::${stateId}::${sinceDays ?? "all"}`;
}

export async function getCommitCounts(
  repoPath: string,
  stateId: string,
  opts: CommitCountsOptions = {},
): Promise<Map<string, number>> {
  const key = cacheKey(repoPath, stateId, opts.sinceDays);
  const cached = inProcCache.get(key);
  if (cached !== undefined) return cached;
  const counts = await buildCommitCounts(repoPath, opts);
  inProcCache.set(key, counts);
  return counts;
}

/** Test hook: drop the in-process cache. */
export function _resetCommitCountsCacheForTests(): void {
  inProcCache.clear();
}
