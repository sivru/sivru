// Tests for memory-file discovery.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverMemoryFiles } from "./load.js";

describe("discoverMemoryFiles", () => {
  let tmp: string;
  let repoRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sivru-load-"));
    repoRoot = join(tmp, "repo");
    homeDir = join(tmp, "home");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns an empty list when no memory files exist", async () => {
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    expect(out).toEqual([]);
  });

  it("finds CLAUDE.md and CLAUDE.local.md at repo root", async () => {
    await writeFile(join(repoRoot, "CLAUDE.md"), "# claude");
    await writeFile(join(repoRoot, "CLAUDE.local.md"), "# local");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    expect(out.map((f) => f.displayPath).sort()).toEqual(["./CLAUDE.local.md", "./CLAUDE.md"]);
    expect(out.every((f) => f.kind === "claude-md")).toBe(true);
  });

  it("finds SKILL.md files at conventional depth", async () => {
    await mkdir(join(repoRoot, ".claude", "skills", "foo"), { recursive: true });
    await writeFile(join(repoRoot, ".claude", "skills", "foo", "SKILL.md"), "# foo");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    expect(out.find((f) => f.displayPath === "./.claude/skills/foo/SKILL.md")?.kind).toBe("skill");
  });

  it("respects the depth-3 cap (skips deeply nested SKILL.md)", async () => {
    await mkdir(join(repoRoot, ".claude", "skills", "a", "b", "c", "d"), { recursive: true });
    await writeFile(join(repoRoot, ".claude", "skills", "a", "b", "c", "d", "SKILL.md"), "# deep");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    expect(out.find((f) => f.path.includes("/d/SKILL.md"))).toBeUndefined();
  });

  it("depth-3-below-anchor matches; depth-4-below-anchor rejects (the exact design boundary)", async () => {
    // .claude/skills/foo/SKILL.md → depth 3 below .claude/ → matches.
    // .claude/skills/foo/sub/SKILL.md → depth 4 → rejects.
    await mkdir(join(repoRoot, ".claude", "skills", "foo", "sub"), { recursive: true });
    await writeFile(join(repoRoot, ".claude", "skills", "foo", "SKILL.md"), "# shallow");
    await writeFile(join(repoRoot, ".claude", "skills", "foo", "sub", "SKILL.md"), "# nested");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    const paths = out.map((f) => f.displayPath);
    expect(paths).toContain("./.claude/skills/foo/SKILL.md");
    expect(paths).not.toContain("./.claude/skills/foo/sub/SKILL.md");
  });

  it("finds agent files in .claude/agents/*.md", async () => {
    await mkdir(join(repoRoot, ".claude", "agents"), { recursive: true });
    await writeFile(join(repoRoot, ".claude", "agents", "Foo.md"), "# foo agent");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    expect(out.find((f) => f.displayPath === "./.claude/agents/Foo.md")?.kind).toBe("agent");
  });

  it("returns user-global ~/.claude/CLAUDE.md alongside repo files", async () => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "CLAUDE.md"), "# user global");
    await writeFile(join(repoRoot, "CLAUDE.md"), "# project");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    expect(out.map((f) => f.displayPath)).toEqual(["./CLAUDE.md", "~/.claude/CLAUDE.md"]);
  });

  it("project files sort before user-global files (stable)", async () => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "CLAUDE.md"), "# user");
    await writeFile(join(repoRoot, "CLAUDE.md"), "# project");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    expect(out[0]?.displayPath.startsWith("./")).toBe(true);
    expect(out[out.length - 1]?.displayPath.startsWith("~/")).toBe(true);
  });

  it("does not de-duplicate project + user-global SKILL.md with the same name", async () => {
    await mkdir(join(repoRoot, ".claude", "skills", "foo"), { recursive: true });
    await mkdir(join(homeDir, ".claude", "skills", "foo"), { recursive: true });
    await writeFile(join(repoRoot, ".claude", "skills", "foo", "SKILL.md"), "# repo");
    await writeFile(join(homeDir, ".claude", "skills", "foo", "SKILL.md"), "# home");
    const out = await discoverMemoryFiles(repoRoot, { homeDir });
    const skills = out.filter((f) => f.kind === "skill");
    expect(skills).toHaveLength(2);
    expect(new Set(skills.map((f) => f.displayPath))).toEqual(
      new Set(["./.claude/skills/foo/SKILL.md", "~/.claude/skills/foo/SKILL.md"]),
    );
  });
});
