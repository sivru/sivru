// Best-effort inference of the canonical project root for a session whose
// cwd no longer exists on disk (typically: a git worktree the user has
// since removed via `git worktree remove`).
//
// We can't ask `git` because the directory is gone. The only signal we
// have is the recorded cwd string itself plus the set of *verified* roots
// (paths where some other session DID resolve via git). If the missing
// cwd looks like `<verified_root><sep><suffix>` for one of those roots,
// it's overwhelmingly likely to have been a worktree of that repo.
//
// We require a natural boundary (`-`, `/`, `_`) right after the matched
// prefix to avoid false-positives like:
//   verifiedRoot = "buildwright"      (different project)
//   missingCwd   = "buildwrightV2-x"  (worktree of buildwrightV2)
// where naive prefix-matching would wrongly group them.

const SEPARATORS = new Set(["-", "/", "_"]);

/**
 * Find the longest verified root that is a prefix of `cwd` with a natural
 * separator between the prefix and the rest. Returns null when no root
 * matches — caller should fall back to using `cwd` as its own root.
 */
export function inferProjectRootFromPrefix(
  cwd: string,
  verifiedRoots: ReadonlySet<string>,
): string | null {
  if (cwd.length === 0) return null;
  let best: string | null = null;
  let bestLen = -1;
  for (const root of verifiedRoots) {
    if (root.length === 0) continue;
    // Exact equality is handled elsewhere — here we only care about strict
    // prefixes (cwd is longer than root).
    if (root === cwd) continue;
    if (cwd.length <= root.length) continue;
    if (!cwd.startsWith(root)) continue;
    // The CRITICAL boundary check.
    const sep = cwd.charAt(root.length);
    if (!SEPARATORS.has(sep)) continue;
    if (root.length > bestLen) {
      best = root;
      bestLen = root.length;
    }
  }
  return best;
}
