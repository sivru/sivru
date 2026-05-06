// Compute the `state_id` used to key the on-disk index cache.
//
// DESIGN.md section 4.6:
//   state_id = commit_sha               if working tree is clean
//            = commit_sha + dirty_hash  if there are uncommitted changes
//            = mtime_hash               if not a git repo
//
// Implementation notes:
//   - Detect git via `git rev-parse HEAD`. Any non-zero exit (or git
//     missing entirely) drops us into the non-git branch.
//   - Cleanliness is decided by `git status --porcelain` -- empty output
//     means clean. The dirty hash is sha256 of `git diff` output.
//   - The non-git branch reuses the engine's existing gitignore-aware
//     walker so the file set considered for hashing matches what a
//     subsequent build would index. Entries are accumulated in walker
//     order, which is already lexicographically deterministic.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { walk } from "../walker/walk.js";

function tryGit(repoPath: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync("git", args as string[], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out;
  } catch {
    return null;
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function computeMtimeStateId(repoPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const entry of walk(repoPath)) {
    // `mtimeMs.toFixed(0)` rounds to integer ms.
    hash.update(`${entry.filePath}:${entry.mtimeMs.toFixed(0)}\n`);
  }
  return `mtime:${hash.digest("hex")}`;
}

export async function computeStateId(repoPath: string): Promise<string> {
  const headOut = tryGit(repoPath, ["rev-parse", "HEAD"]);
  if (headOut === null) {
    return computeMtimeStateId(repoPath);
  }
  const sha = headOut.trim();
  if (sha.length === 0) {
    return computeMtimeStateId(repoPath);
  }

  const status = tryGit(repoPath, ["status", "--porcelain"]);
  if (status === null) {
    // We resolved HEAD but `status` somehow failed: fall back to mtime,
    // which is conservative (cache miss beats stale hit).
    return computeMtimeStateId(repoPath);
  }
  if (status.trim().length === 0) {
    return sha;
  }

  // Dirty: state_id = `<sha>:<sha256_hex(git diff output)>` per DESIGN.md 4.6.
  const diff = tryGit(repoPath, ["diff"]) ?? "";
  const dirtyHash = sha256Hex(diff);
  return `${sha}:${dirtyHash}`;
}
