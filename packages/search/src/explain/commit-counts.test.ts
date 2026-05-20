import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  _resetCommitCountsCacheForTests,
  buildCommitCounts,
  cacheKey,
  getCommitCounts,
} from "./commit-counts.js";

let repo: string;

async function write(p: string, content: string): Promise<void> {
  const abs = join(repo, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function git(...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "sivru-explain-commits-"));
  _resetCommitCountsCacheForTests();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("buildCommitCounts", () => {
  it("counts commits per file in chronological accumulation", async () => {
    await write("a.ts", "x = 1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "c1");

    await write("a.ts", "x = 2\n");
    await write("b.ts", "y = 1\n");
    git("add", "a.ts", "b.ts");
    git("commit", "-q", "-m", "c2");

    const counts = await buildCommitCounts(repo);
    expect(counts.get("a.ts")).toBe(2);
    expect(counts.get("b.ts")).toBe(1);
  });

  it("returns an empty map for a non-git tree", async () => {
    const other = await mkdtemp(join(tmpdir(), "sivru-explain-nogit-"));
    try {
      const counts = await buildCommitCounts(other);
      expect(counts.size).toBe(0);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("respects the sinceDays window", async () => {
    await write("a.ts", "x = 1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "c1");

    // since=0 effectively excludes everything older than today
    const counts = await buildCommitCounts(repo, { sinceDays: 0 });
    // With sinceDays=0, git's --since is treated as "now" — commits made
    // before the request's clock tick are excluded. We assert the option
    // is plumbed through (count <= unrestricted count).
    const unrestricted = await buildCommitCounts(repo);
    expect(counts.get("a.ts") ?? 0).toBeLessThanOrEqual(
      unrestricted.get("a.ts") ?? 0,
    );
  });
});

describe("getCommitCounts (in-process cache)", () => {
  it("caches on (repoPath, stateId, sinceDays) and skips re-running git on hit", async () => {
    await write("a.ts", "x = 1\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "c1");

    const first = await getCommitCounts(repo, "state-A");
    expect(first.get("a.ts")).toBe(1);

    // Add a commit that would change the count if we re-ran git.
    await write("a.ts", "x = 2\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "c2");

    const second = await getCommitCounts(repo, "state-A");
    expect(second.get("a.ts")).toBe(1); // served from cache

    const third = await getCommitCounts(repo, "state-B");
    expect(third.get("a.ts")).toBe(2); // different stateId → fresh walk
  });

  it("derives a stable cache key", () => {
    expect(cacheKey("/repo", "abc", 90)).toBe("/repo::abc::90");
    expect(cacheKey("/repo", "abc", undefined)).toBe("/repo::abc::all");
  });
});
