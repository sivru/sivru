// Batched git shell-outs for the coach loop (DESIGN-0005 §3a + E1).
//
// Per E1: one `git log` per file capturing lastEdit + last-commit; one
// `git rev-list --count HEAD` per run, cached. Cuts shell-outs ~3×
// compared with naive per-call invocation.
//
// Every failure mode is rescued (DESIGN-0005 §3a "Git failure modes"
// + Failure modes table). Callers never see a thrown exception from
// this module.

import { runCmd } from "./exec.js";

export interface PerFileStats {
  /** Unix seconds of the file's last commit. */
  lastCommitTs: number;
  /** sha of the file's last commit. */
  lastCommitHash: string;
}

export type GitDegradationReason =
  | "missing"
  | "not-a-git-tree"
  | "ok";

export interface GitContext {
  /** True when shell-outs are usable; false when binary missing or path isn't a git tree. */
  available: boolean;
  reason: GitDegradationReason;
}

/**
 * Probe whether `cwd` is a git working tree and `git` is on PATH.
 * Called once per run; the result gates every subsequent shell-out.
 */
export async function probeGit(cwd: string): Promise<GitContext> {
  const r = await runCmd("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (!r.ok) {
    if (r.reason === "missing") return { available: false, reason: "missing" };
    return { available: false, reason: "not-a-git-tree" };
  }
  const out = r.stdout.trim();
  if (out !== "true") return { available: false, reason: "not-a-git-tree" };
  return { available: true, reason: "ok" };
}

/**
 * One `git log` per file. Returns `null` for per-file failures
 * (corrupted repo, timeout, non-zero exit) — caller treats that as
 * "no git data for this file" and falls back to mtime.
 *
 * Uses `--follow` so renames in history don't lose `lastCommitTs`. The
 * `--diff-filter=AMRD` filter excludes commits that didn't actually
 * change the path (added/modified/renamed/deleted; excludes the
 * tree-walk noise like commits that touched a parent dir).
 */
export async function perFileStats(
  cwd: string,
  filePath: string,
): Promise<PerFileStats | null> {
  const r = await runCmd(
    "git",
    [
      "log",
      "-1",
      "--follow",
      "--diff-filter=AMRD",
      "--format=%H%n%ct",
      "--",
      filePath,
    ],
    { cwd },
  );
  if (!r.ok) return null;
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const hash = lines[0] ?? "";
  const tsRaw = lines[1] ?? "";
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts) || hash.length === 0) return null;
  return { lastCommitTs: ts, lastCommitHash: hash };
}

/**
 * `git rev-list --count HEAD` — cached once per run by the orchestrator.
 * Returns null on any failure mode.
 */
export async function headCommitCount(cwd: string): Promise<number | null> {
  const r = await runCmd("git", ["rev-list", "--count", "HEAD"], { cwd });
  if (!r.ok) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * `git rev-list --count <hash>..HEAD` — how many commits HEAD is ahead
 * of the file's last commit. Returns null on any failure mode.
 *
 * Cheaper than computing `headCommitCount - perFileCommitCount` because
 * git can short-circuit when the range is small.
 */
export async function commitsBehindHead(
  cwd: string,
  lastCommitHash: string,
): Promise<number | null> {
  if (lastCommitHash.length === 0) return null;
  const r = await runCmd(
    "git",
    ["rev-list", "--count", `${lastCommitHash}..HEAD`],
    { cwd },
  );
  if (!r.ok) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export interface DiffSegmentBucket {
  /** First path segment under repoRoot — `(root)` for root-level files. */
  segment: string;
  count: number;
}

const MAX_DIFF_PATHS = 10_000;

/**
 * D6a delight — `git diff --name-only --diff-filter=AMD <from>..HEAD`
 * bucketed by first path segment, top-N by count.
 *
 * Returns null on any failure (binary missing, non-zero, timeout). The
 * preview is delight, not correctness — caller emits the finding
 * without it on null.
 */
export async function diffBucketsByFirstSegment(
  cwd: string,
  fromHash: string,
  topN = 3,
): Promise<DiffSegmentBucket[] | null> {
  const r = await runCmd(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=AMD",
      `${fromHash}..HEAD`,
    ],
    { cwd },
  );
  if (!r.ok) return null;
  const lines = r.stdout.split("\n").filter((l) => l.length > 0).slice(0, MAX_DIFF_PATHS);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const slash = line.indexOf("/");
    const seg = slash < 0 ? "(root)" : line.slice(0, slash) + "/";
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, topN)
    .map(([segment, count]) => ({ segment, count }));
  return sorted;
}

export interface RenameSuggestion {
  /** Path the file was renamed to (most recent rename target). */
  target: string;
  /** Commit sha (short — first 12 chars) the rename was committed in. */
  commit: string;
  /** Unix seconds the rename was committed. */
  ts: number;
}

const RENAME_MAX_COMMITS = 500;

/**
 * D6b delight — find the most-recent commit that deleted `path`, then
 * inspect that commit's `git show --name-status` (with rename detection)
 * for an R-status line whose source is `path`. Bounded to the most
 * recent 500 commits OR 365 days (whichever fires first).
 *
 * Returns null when:
 *  - git is unavailable,
 *  - no deletion of `path` is in history,
 *  - the deletion commit doesn't carry a matching rename,
 *  - the rename score is < 90 (ambiguous),
 *  - or the deletion commit shows multiple rename candidates from
 *    `path` (multi-source ambiguity).
 *
 * `--follow` is NOT used here because git's `--follow` only walks back
 * from a path that exists in HEAD. Memory files reference paths that
 * have been deleted; we walk forward from the deletion.
 */
export async function findRecentRename(
  cwd: string,
  path: string,
): Promise<RenameSuggestion | null> {
  // Find the commit where `path` was deleted.
  const sinceArg = `${365}.days.ago`;
  const delRes = await runCmd(
    "git",
    [
      "log",
      `-n`,
      String(RENAME_MAX_COMMITS),
      "--since",
      sinceArg,
      "--diff-filter=D",
      "--format=%H%n%ct",
      "--",
      path,
    ],
    { cwd },
  );
  if (!delRes.ok) return null;
  const delLines = delRes.stdout.split("\n").filter((l) => l.length > 0);
  if (delLines.length < 2) return null;
  const delHash = delLines[0] ?? "";
  const delTs = Number.parseInt(delLines[1] ?? "0", 10);
  if (delHash.length === 0) return null;

  // Inspect that commit's full diff with rename detection on.
  const showRes = await runCmd(
    "git",
    ["show", "--name-status", "--format=", delHash],
    { cwd },
  );
  if (!showRes.ok) return null;

  // Look for an R<score>\t<from>\t<to> row whose <from> is our path.
  const candidates: Array<{ score: number; target: string }> = [];
  for (const line of showRes.stdout.split("\n")) {
    if (line.length === 0) continue;
    if (!line.startsWith("R")) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const m = /^R(\d+)$/.exec(parts[0] ?? "");
    if (m === null) continue;
    const score = Number.parseInt(m[1] ?? "0", 10);
    const from = parts[1] ?? "";
    const to = parts[2] ?? "";
    if (from !== path) continue;
    candidates.push({ score, target: to });
  }
  if (candidates.length === 0) return null;
  // Multi-source ambiguity from `path` → bail.
  if (candidates.length > 1) return null;
  const first = candidates[0];
  if (first === undefined) return null;
  if (first.score < 90) return null;
  return {
    target: first.target,
    commit: delHash.slice(0, 12),
    ts: Number.isFinite(delTs) ? delTs : 0,
  };
}
