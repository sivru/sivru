// Materialize the base ref and build its ExplainerModel for `--diff` (DESIGN-0023
// Slice 1). The model builder reads the working tree, so the base is checked out
// into a STABLE per-ref git worktree (so the stateId-keyed model cache hits
// across runs), serialized by an advisory lock, prune-recovered, and reused.
//
//   resolve base sha ──► flock(worktree) ──► prune + add --force ──► projectModel
//        │ (no sha)                                                      │
//        ▼                                                               ▼
//   { ok:false } → exit 2 (could-not-evaluate, loud)              { ok:true, model }
//
// git is injectable for tests so the orchestration needs no real checkout.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { projectModel } from "./model.js";
import type { ExplainerModel } from "./types.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DiffWorktreeDeps {
  /** Run git (throws on non-zero); returns trimmed stdout. */
  git: (args: string[], cwd: string) => Promise<string>;
  /** Build the model for a repo path (default: projectModel). */
  build: (repoPath: string) => Promise<ExplainerModel>;
}

/** ok → the base model; not-ok → exit 2 (could-not-evaluate), never a silent pass. */
export type BaseModelResult =
  | { ok: true; model: ExplainerModel; baseRef: string }
  | { ok: false; reason: string };

const defaultDeps: DiffWorktreeDeps = {
  git: async (args, cwd) => (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim(),
  build: (p) => projectModel(p),
};

const worktreeRoot = (): string => join(homedir(), ".cache", "sivru", "base-worktrees");

/** Advisory lock via exclusive file create; best-effort after ~10s (stale lock). */
async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      try {
        return await fn();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await sleep(200);
    }
  }
  return fn(); // give up waiting; proceed best-effort
}

/** Resolve the base to a commit sha: explicit ref, else merge-base with the default branch. */
async function resolveBase(
  repoRoot: string,
  explicit: string | null,
  git: DiffWorktreeDeps["git"],
): Promise<string | null> {
  try {
    if (explicit) return await git(["rev-parse", "--verify", `${explicit}^{commit}`], repoRoot);
    let ref = "origin/HEAD";
    try {
      await git(["rev-parse", "--verify", "origin/HEAD"], repoRoot);
    } catch {
      ref = "origin/main";
    }
    return await git(["merge-base", "HEAD", ref], repoRoot);
  } catch {
    return null;
  }
}

export async function buildBaseModel(
  repoRoot: string,
  explicitBase: string | null,
  deps: Partial<DiffWorktreeDeps> = {},
): Promise<BaseModelResult> {
  const d: DiffWorktreeDeps = { ...defaultDeps, ...deps };
  const sha = await resolveBase(repoRoot, explicitBase, d.git);
  if (sha === null) {
    return {
      ok: false,
      reason: explicitBase
        ? `base ref "${explicitBase}" not found — is it fetched? CI needs fetch-depth: 0`
        : `could not resolve a base (no origin/HEAD or origin/main) — CI needs fetch-depth: 0`,
    };
  }
  const slug = createHash("sha256").update(`${repoRoot}\0${sha}`).digest("hex").slice(0, 16);
  const wt = join(worktreeRoot(), slug);
  try {
    await mkdir(worktreeRoot(), { recursive: true });
    return await withLock(`${wt}.lock`, async () => {
      await d.git(["worktree", "prune"], repoRoot).catch(() => {});
      // Reuse the stable worktree if it's already at the right sha (the whole
      // point of the per-ref path — the model cache hits). Otherwise (re)create.
      let atSha = false;
      try {
        atSha = (await d.git(["rev-parse", "HEAD"], wt)) === sha;
      } catch {
        atSha = false; // not a checkout / doesn't exist
      }
      if (!atSha) {
        await d.git(["worktree", "remove", "--force", wt], repoRoot).catch(() => {});
        await d.git(["worktree", "add", "--force", "--detach", wt, sha], repoRoot);
      }
      const model = await d.build(wt);
      return { ok: true as const, model, baseRef: explicitBase ?? sha.slice(0, 8) };
    });
  } catch (err) {
    return { ok: false, reason: `base worktree/build failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
