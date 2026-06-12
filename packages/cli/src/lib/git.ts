// Small git helpers shared across the CLI. All run git scoped to an explicit
// repo root (`-C`) so they're correct regardless of the process CWD, and all
// degrade to a safe default (never throw) when the path isn't a git repo.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Short HEAD of the repo at `repoRoot`, or "" if it's not a git repo. */
export async function gitHeadShort(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

/** True if `absPath` has uncommitted changes. False when not a git repo. */
export async function gitFileDirty(repoRoot: string, absPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "status", "--porcelain", "--", absPath]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
