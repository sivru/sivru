// Tests for memory-claude-age check.

import { describe, expect, it } from "vitest";

import { memoryClaudeAge } from "./claude-age.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { AuditContext, MemoryFile } from "../types.js";

function daysAgoMs(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function daysAgoSec(days: number): number {
  return Math.floor(daysAgoMs(days) / 1000);
}

function file(overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    path: "/repo/CLAUDE.md",
    displayPath: "./CLAUDE.md",
    kind: "claude-md",
    mtimeMs: daysAgoMs(0),
    ...overrides,
  };
}

function ctx(files: MemoryFile[], opts: Partial<AuditContext> = {}): AuditContext {
  return {
    repoRoot: "/repo",
    memoryFiles: files,
    config: DEFAULT_CONFIG,
    noGit: true,
    isGitRepo: false,
    homeDir: "/tmp/fake-home",
    ...opts,
  };
}

describe("memoryClaudeAge", () => {
  it("returns no findings for a fresh file (10 days, 5 commits behind)", async () => {
    const f = file({
      lastCommitTs: daysAgoSec(10),
      commitsBehindHead: 5,
    });
    const out = await memoryClaudeAge.run(ctx([f]));
    expect(out).toEqual([]);
  });

  it("does not flag old + low-churn (200d, 30 commits)", async () => {
    const f = file({
      lastCommitTs: daysAgoSec(200),
      commitsBehindHead: 30,
    });
    const out = await memoryClaudeAge.run(ctx([f]));
    expect(out).toEqual([]);
  });

  it("does not flag young + high-churn (40d, 500 commits)", async () => {
    const f = file({
      lastCommitTs: daysAgoSec(40),
      commitsBehindHead: 500,
    });
    const out = await memoryClaudeAge.run(ctx([f]));
    expect(out).toEqual([]);
  });

  it("flags old + high-churn (200d, 500 commits)", async () => {
    const f = file({
      lastCommitTs: daysAgoSec(200),
      commitsBehindHead: 500,
    });
    const out = await memoryClaudeAge.run(ctx([f]));
    expect(out).toHaveLength(1);
    expect(out[0]?.checkId).toBe("memory-claude-age");
    expect(out[0]?.severity).toBe("info");
  });

  it("boundary 90d + 50 commits: aged (both inclusive)", async () => {
    const f = file({
      lastCommitTs: daysAgoSec(90),
      commitsBehindHead: 50,
    });
    const out = await memoryClaudeAge.run(ctx([f]));
    expect(out).toHaveLength(1);
  });

  it("mtime mode only requires the day floor (no commit data)", async () => {
    const f = file({
      mtimeMs: daysAgoMs(120),
      // no lastCommitTs, no commitsBehindHead
    });
    const out = await memoryClaudeAge.run(ctx([f]));
    expect(out).toHaveLength(1);
    expect(out[0]?.summary).toMatch(/mtime mode/);
  });

  it("skips unreadable files", async () => {
    const f = file({
      mtimeMs: daysAgoMs(120),
      unreadable: true,
    });
    const out = await memoryClaudeAge.run(ctx([f]));
    expect(out).toEqual([]);
  });
});
