// Resolve a cwd path to its canonical git project root + worktree info.
//
// Claude Code records sessions per-cwd in `~/.claude/projects/<encoded-cwd>/`.
// When the user is working in a *git worktree* (a separate directory that
// shares a `.git` with another checkout), each worktree shows up as its own
// project in the UI even though they're the same logical project.
//
// This module fixes that by running `git` once per unique cwd to recover:
//   - the canonical project root (parent of the SHARED `.git` dir, so all
//     worktrees of the same repo collapse to one)
//   - whether this cwd is a linked worktree vs. the main checkout
//   - the current branch (for sub-labelling worktree sessions in the UI)
//
// Results are cached per cwd-string; we never re-resolve the same path.
//
// Privacy: this only spawns local `git` processes — no network egress, no
// fetch / http / https / net imports. DESIGN.md §5.5 holds.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type GitInfo = {
  /** Canonical project root — same string for every worktree of the same repo. */
  projectRoot: string;
  /** True when cwd is a linked worktree (i.e., `.git` is a file pointer, not a dir). */
  isWorktree: boolean;
  /** Current branch, if `git` could resolve one. May be null on detached HEAD. */
  branch: string | null;
};

const CACHE = new Map<string, Promise<GitInfo | null>>();

function exec(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolveFn) => {
    const child = execFile(
      cmd,
      args,
      { cwd, encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 64 },
      (err, stdout) => {
        resolveFn({
          ok: err === null,
          stdout: typeof stdout === "string" ? stdout.trim() : "",
        });
      },
    );
    child.on("error", () => resolveFn({ ok: false, stdout: "" }));
  });
}

/**
 * Look up GitInfo for `cwd`. Cached. Returns null when:
 *   - cwd does not exist on disk (session from a deleted checkout)
 *   - cwd is not inside a git repo
 *   - `git` is not on PATH
 *
 * The caller should fall back to the raw cwd as the "project" identity.
 */
export function resolveGitInfo(cwd: string): Promise<GitInfo | null> {
  const cached = CACHE.get(cwd);
  if (cached !== undefined) return cached;
  const promise = resolveUncached(cwd);
  CACHE.set(cwd, promise);
  return promise;
}

async function resolveUncached(cwd: string): Promise<GitInfo | null> {
  if (!existsSync(cwd)) return null;

  // git rev-parse --git-common-dir prints the SHARED .git directory — this
  // is identical across all worktrees of the same repo. Parent of common
  // dir is the main project root.
  const common = await exec(
    "git",
    ["rev-parse", "--git-common-dir"],
    cwd,
  );
  if (!common.ok || common.stdout.length === 0) return null;
  const commonDir = isAbsolute(common.stdout)
    ? common.stdout
    : resolve(cwd, common.stdout);
  // commonDir typically ends with `.git` — project root is the parent.
  // (For bare repos commonDir IS the repo, but Claude Code wouldn't be
  // run inside a bare repo, so we treat parent as the right answer.)
  // Canonicalize via realpath so two sessions on the same dir reached
  // through different symlinks (`/var/...` vs `/private/var/...` on macOS,
  // or a user-level `~/code` symlink to `~/dev`) collapse to one.
  const rawRoot = dirname(commonDir);
  let projectRoot: string;
  try {
    projectRoot = realpathSync(rawRoot);
  } catch {
    projectRoot = rawRoot;
  }

  // git rev-parse --git-dir vs --git-common-dir: equal in main checkouts,
  // different in linked worktrees (where --git-dir is `.git/worktrees/<name>`).
  const gitDir = await exec("git", ["rev-parse", "--git-dir"], cwd);
  const gitDirAbs =
    gitDir.ok && gitDir.stdout.length > 0
      ? isAbsolute(gitDir.stdout)
        ? gitDir.stdout
        : resolve(cwd, gitDir.stdout)
      : commonDir;
  const isWorktree = gitDirAbs !== commonDir;

  const branchRes = await exec("git", ["branch", "--show-current"], cwd);
  const branch =
    branchRes.ok && branchRes.stdout.length > 0 ? branchRes.stdout : null;

  return { projectRoot, isWorktree, branch };
}

/** Test-only: clear the resolution cache. */
export function _resetGitInfoCache(): void {
  CACHE.clear();
}
