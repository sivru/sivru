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
