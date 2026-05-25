// Tests for batched git shell-outs. Each test seeds a fresh git repo
// in a tmp dir; tests are skipped if `git` isn't on PATH.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCmd } from "./exec.js";
import {
  diffBucketsByFirstSegment,
  findRecentRename,
  headCommitCount,
  perFileStats,
  probeGit,
} from "./git-stats.js";

async function gitAvailable(): Promise<boolean> {
  const r = await runCmd("git", ["--version"]);
  return r.ok;
}

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sivru-gitstats-"));
  await runCmd("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await runCmd("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCmd("git", ["config", "user.name", "test"], { cwd: dir });
  // commit.gpgsign is forced off so signing config on the host doesn't break the test.
  await runCmd("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}

async function commit(dir: string, files: Record<string, string>, msg: string): Promise<void> {
  for (const [p, body] of Object.entries(files)) {
    await writeFile(join(dir, p), body);
  }
  await runCmd("git", ["add", "-A"], { cwd: dir });
  await runCmd("git", ["commit", "-q", "-m", msg], { cwd: dir });
}

describe("git-stats — probeGit", () => {
  let tmp: string;

  beforeEach(async () => {
    if (!(await gitAvailable())) return;
    tmp = await gitRepo();
  });

  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  });

  it("recognizes a git working tree", async () => {
    if (!(await gitAvailable())) return;
    const r = await probeGit(tmp);
    expect(r.available).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("reports not-a-git-tree for an ordinary directory", async () => {
    if (!(await gitAvailable())) return;
    const dir = await mkdtemp(join(tmpdir(), "sivru-not-git-"));
    const r = await probeGit(dir);
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-a-git-tree");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("git-stats — perFileStats + headCommitCount", () => {
  let tmp: string;

  beforeEach(async () => {
    if (!(await gitAvailable())) return;
    tmp = await gitRepo();
    await commit(tmp, { "a.md": "hello" }, "first");
    await commit(tmp, { "b.md": "world" }, "second");
    await commit(tmp, { "c.md": "z" }, "third");
  });

  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  });

  it("returns the last-commit metadata for a tracked file", async () => {
    if (!(await gitAvailable())) return;
    const stats = await perFileStats(tmp, "a.md");
    expect(stats).not.toBeNull();
    expect(stats?.lastCommitHash.length).toBeGreaterThan(0);
    expect(stats?.lastCommitTs).toBeGreaterThan(0);
  });

  it("headCommitCount counts HEAD revisions", async () => {
    if (!(await gitAvailable())) return;
    const n = await headCommitCount(tmp);
    expect(n).toBe(3);
  });
});

describe("git-stats — diffBucketsByFirstSegment + findRecentRename", () => {
  let tmp: string;

  beforeEach(async () => {
    if (!(await gitAvailable())) return;
    tmp = await gitRepo();
  });

  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  });

  it("buckets a diff by first path segment", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, { "anchor.md": "x" }, "anchor");
    const anchor = await perFileStats(tmp, "anchor.md");
    // Add new files in different segments
    await runCmd("git", ["init", "-q"], { cwd: tmp });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "docs"), { recursive: true });
    await writeFile(join(tmp, "src", "a.ts"), "1");
    await writeFile(join(tmp, "src", "b.ts"), "2");
    await writeFile(join(tmp, "docs", "x.md"), "y");
    await runCmd("git", ["add", "-A"], { cwd: tmp });
    await runCmd("git", ["commit", "-q", "-m", "more"], { cwd: tmp });

    const buckets = await diffBucketsByFirstSegment(tmp, anchor!.lastCommitHash);
    expect(buckets).not.toBeNull();
    const segments = (buckets ?? []).map((b) => b.segment);
    expect(segments).toContain("src/");
    expect(segments).toContain("docs/");
  });

  it("findRecentRename surfaces a rename when score is high", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, { "scanner.ts": "export const x = 1;\nexport const y = 2;\n" }, "init scanner");
    await runCmd("git", ["mv", "scanner.ts", "audit.ts"], { cwd: tmp });
    await runCmd("git", ["commit", "-q", "-m", "rename"], { cwd: tmp });

    const rn = await findRecentRename(tmp, "scanner.ts");
    expect(rn).not.toBeNull();
    expect(rn?.target).toBe("audit.ts");
    expect(rn?.commit.length).toBe(12);
  });

  it("findRecentRename returns null for paths without a rename in history", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, { "stable.ts": "x" }, "stable");
    const rn = await findRecentRename(tmp, "stable.ts");
    expect(rn).toBeNull();
  });
});
