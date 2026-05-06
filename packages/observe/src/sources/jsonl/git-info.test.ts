import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _resetGitInfoCache, resolveGitInfo } from "./git-info";

let scratch: string;
function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function git(cwd: string, ...args: string[]): void {
  execSync(`git -C "${cwd}" ${args.join(" ")}`, { stdio: "ignore" });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "sivru-gitinfo-"));
  _resetGitInfoCache();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("resolveGitInfo", () => {
  it("returns null for a non-existent path", async () => {
    const ghost = resolve(scratch, "no-such-dir");
    const info = await resolveGitInfo(ghost);
    expect(info).toBeNull();
  });

  it("returns null for a directory that isn't a git repo", async () => {
    const info = await resolveGitInfo(scratch);
    expect(info).toBeNull();
  });

  it("resolves the project root for a plain main checkout", async () => {
    const repo = join(scratch, "repo");
    mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.email", "test@test.test");
    git(repo, "config", "user.name", "test");
    writeFileSync(join(repo, "README.md"), "# x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init", "--no-gpg-sign");

    const info = await resolveGitInfo(repo);
    expect(info).not.toBeNull();
    expect(info?.projectRoot).toBe(realpath(repo));
    expect(info?.isWorktree).toBe(false);
  });

  it("collapses a worktree to the main repo's project root", async () => {
    const main = join(scratch, "main");
    mkdirSync(main);
    git(main, "init");
    git(main, "config", "user.email", "test@test.test");
    git(main, "config", "user.name", "test");
    writeFileSync(join(main, "f.txt"), "x\n");
    git(main, "add", ".");
    git(main, "commit", "-m", "init", "--no-gpg-sign");

    // Create a linked worktree on a new branch.
    const wt = join(scratch, "feature-x");
    git(main, "worktree", "add", "-b", "feature-x", wt);

    const mainInfo = await resolveGitInfo(main);
    const wtInfo = await resolveGitInfo(wt);

    // The CRITICAL property: worktree resolves to the SAME projectRoot as
    // the main checkout. This is what makes the project switcher collapse
    // them into one entry instead of two.
    expect(mainInfo?.projectRoot).toBe(realpath(main));
    expect(wtInfo?.projectRoot).toBe(realpath(main));

    // And the worktree is correctly flagged.
    expect(mainInfo?.isWorktree).toBe(false);
    expect(wtInfo?.isWorktree).toBe(true);

    // Branch reflects the actual checked-out branch in each.
    expect(wtInfo?.branch).toBe("feature-x");
  });

  it("caches results — same cwd returns the same promise", async () => {
    const repo = join(scratch, "repo");
    mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");

    const a = resolveGitInfo(repo);
    const b = resolveGitInfo(repo);
    // Identity check — proves the cache hit, not just equal values.
    expect(a).toBe(b);
  });

  it("returns null for a stale cwd that no longer exists on disk", async () => {
    const ghost = join(scratch, "deleted-checkout");
    const info = await resolveGitInfo(ghost);
    expect(info).toBeNull();
  });
});
