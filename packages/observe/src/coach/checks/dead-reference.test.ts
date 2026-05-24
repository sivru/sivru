// Tests for memory-dead-reference helpers + end-to-end via a temp dir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { filterAndNormalize, scanForPathCandidates, memoryDeadReference } from "./dead-reference.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { AuditContext, MemoryFile } from "../types.js";

describe("filterAndNormalize", () => {
  const exts = DEFAULT_CONFIG.pathExtensions;

  it("accepts strings starting with ./, ../, ~/, /", () => {
    for (const s of ["./foo", "../foo", "~/foo", "/abs/foo"]) {
      expect(filterAndNormalize(s, exts)).toBe(s);
    }
  });

  it("accepts strings with mid-string /", () => {
    expect(filterAndNormalize("docs/x.md", exts)).toBe("docs/x.md");
  });

  it("accepts strings with a known extension", () => {
    expect(filterAndNormalize("foo.ts", exts)).toBe("foo.ts");
  });

  it("rejects bare identifiers", () => {
    expect(filterAndNormalize("runScan", exts)).toBeNull();
    expect(filterAndNormalize("--strict", exts)).toBeNull();
    expect(filterAndNormalize("pnpm", exts)).toBeNull();
  });

  it("strips #anchor and ?query before resolution", () => {
    expect(filterAndNormalize("docs/x.md#anchor", exts)).toBe("docs/x.md");
    expect(filterAndNormalize("docs/x.md?q=1", exts)).toBe("docs/x.md");
  });

  it("rejects whitespace-containing strings", () => {
    expect(filterAndNormalize("foo bar", exts)).toBeNull();
  });

  it("rejects URL-scheme strings inside inline-code spans (false-positive guard)", () => {
    expect(filterAndNormalize("https://example.com/spec.md", exts)).toBeNull();
    expect(filterAndNormalize("mailto:x@example.com", exts)).toBeNull();
    expect(filterAndNormalize("git+ssh://github.com/foo/bar.git", exts)).toBeNull();
  });
});

describe("scanForPathCandidates — fence handling", () => {
  it("collects inline-code spans from a normal paragraph", () => {
    const res = scanForPathCandidates("See `foo.ts` and `bar.md` files.");
    expect(res.candidates.map((c) => c.raw)).toEqual(["foo.ts", "bar.md"]);
  });

  it("ignores triple-backtick fenced blocks entirely", () => {
    const md = [
      "Outside `kept.ts`.",
      "```",
      "Inside `skipped.ts`.",
      "```",
      "After `kept2.ts`.",
    ].join("\n");
    const res = scanForPathCandidates(md);
    expect(res.candidates.map((c) => c.raw).sort()).toEqual(["kept.ts", "kept2.ts"]);
  });

  it("ignores triple-tilde fenced blocks", () => {
    const md = ["Before `kept.ts`.", "~~~", "`skipped.ts`", "~~~", "After `kept2.ts`."].join("\n");
    const res = scanForPathCandidates(md);
    expect(res.candidates.map((c) => c.raw).sort()).toEqual(["kept.ts", "kept2.ts"]);
  });

  it("ignores 4-space-indented blocks after a blank line", () => {
    const md = [
      "Outside `kept.ts`.",
      "",
      "    `inside.ts`",
      "    more indented `also-inside.ts`",
      "",
      "After `kept2.ts`.",
    ].join("\n");
    const res = scanForPathCandidates(md);
    expect(res.candidates.map((c) => c.raw).sort()).toEqual(["kept.ts", "kept2.ts"]);
  });

  it("captures markdown link targets that look like paths", () => {
    const res = scanForPathCandidates("See [the doc](docs/x.md).");
    expect(res.candidates.map((c) => c.raw)).toContain("docs/x.md");
  });

  it("skips URL-scheme markdown link targets", () => {
    const res = scanForPathCandidates("See [home](https://example.com).");
    expect(res.candidates).toHaveLength(0);
  });

  it("tracks 1-indexed line numbers", () => {
    const res = scanForPathCandidates("line1\nlinetwo `foo.ts`\nline3");
    expect(res.candidates[0]?.line).toBe(2);
  });
});

describe("memoryDeadReference (integration)", () => {
  let tmp: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sivru-deadref-"));
    repoRoot = join(tmp, "repo");
    await mkdir(repoRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function makeContext(memoryFiles: MemoryFile[]): AuditContext {
    return {
      repoRoot,
      memoryFiles,
      config: DEFAULT_CONFIG,
      noGit: true, // delight suppressed — keeps tests deterministic
      isGitRepo: false,
      homeDir: tmp, // hermetic homedir
    };
  }

  it("flags broken inline-code path references", async () => {
    await writeFile(join(repoRoot, "CLAUDE.md"), "See `does/not/exist.ts`.");
    const file: MemoryFile = {
      path: join(repoRoot, "CLAUDE.md"),
      displayPath: "./CLAUDE.md",
      kind: "claude-md",
      mtimeMs: Date.now(),
    };
    const out = await memoryDeadReference.run(makeContext([file]));
    expect(out).toHaveLength(1);
    expect(out[0]?.summary).toContain("does/not/exist.ts");
  });

  it("does not flag bare identifiers", async () => {
    await writeFile(join(repoRoot, "CLAUDE.md"), "Run `pnpm install` then `runScan`.");
    const file: MemoryFile = {
      path: join(repoRoot, "CLAUDE.md"),
      displayPath: "./CLAUDE.md",
      kind: "claude-md",
      mtimeMs: Date.now(),
    };
    const out = await memoryDeadReference.run(makeContext([file]));
    expect(out).toHaveLength(0);
  });

  it("does not flag existing paths", async () => {
    await mkdir(join(repoRoot, "docs"), { recursive: true });
    await writeFile(join(repoRoot, "docs", "x.md"), "x");
    await writeFile(join(repoRoot, "CLAUDE.md"), "See `docs/x.md`.");
    const file: MemoryFile = {
      path: join(repoRoot, "CLAUDE.md"),
      displayPath: "./CLAUDE.md",
      kind: "claude-md",
      mtimeMs: Date.now(),
    };
    const out = await memoryDeadReference.run(makeContext([file]));
    expect(out).toHaveLength(0);
  });

  it("ignores broken paths inside fenced code blocks", async () => {
    await writeFile(join(repoRoot, "CLAUDE.md"), "Sample:\n```\n`docs/not-real.ts`\n```\n");
    const file: MemoryFile = {
      path: join(repoRoot, "CLAUDE.md"),
      displayPath: "./CLAUDE.md",
      kind: "claude-md",
      mtimeMs: Date.now(),
    };
    const out = await memoryDeadReference.run(makeContext([file]));
    expect(out).toHaveLength(0);
  });

  it("skips findings for user-global files with relative paths (ambiguous resolution)", async () => {
    await writeFile(join(repoRoot, "CLAUDE.md"), "See `docs/x.md`.");
    const file: MemoryFile = {
      path: join(repoRoot, "CLAUDE.md"),
      displayPath: "~/.claude/CLAUDE.md", // pretend it's user-global
      kind: "claude-md",
      mtimeMs: Date.now(),
    };
    const out = await memoryDeadReference.run(makeContext([file]));
    expect(out).toHaveLength(0);
  });
});
