// Tests for memory-skill-tools-drift.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memorySkillToolsDrift, parseToolsField } from "./skill-tools-drift.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { AuditContext, MemoryFile } from "../types.js";

describe("parseToolsField", () => {
  it("parses flow-style: tools: [A, B, C]", () => {
    expect(parseToolsField("tools: [Bash, Read, Edit]")).toEqual(["Bash", "Read", "Edit"]);
  });

  it("parses block-style: tools:\\n  - A\\n  - B", () => {
    expect(parseToolsField("tools:\n  - Bash\n  - Read")).toEqual(["Bash", "Read"]);
  });

  it("strips surrounding quotes", () => {
    expect(parseToolsField('tools: ["Bash", "Read"]')).toEqual(["Bash", "Read"]);
    expect(parseToolsField("tools: ['Bash']")).toEqual(["Bash"]);
  });

  it("returns null when the field is missing", () => {
    expect(parseToolsField("name: foo\ndescription: bar")).toBeNull();
  });

  it("returns empty list for tools: []", () => {
    expect(parseToolsField("tools: []")).toEqual([]);
  });
});

describe("memorySkillToolsDrift (integration)", () => {
  let tmp: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sivru-tooldrift-"));
    repoRoot = join(tmp, "repo");
    await mkdir(repoRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function ctx(files: MemoryFile[]): AuditContext {
    return {
      repoRoot,
      memoryFiles: files,
      config: DEFAULT_CONFIG,
      noGit: true,
      isGitRepo: false,
      homeDir: tmp,
    };
  }

  async function writeSkill(p: string, body: string): Promise<MemoryFile> {
    await mkdir(join(repoRoot, ".claude", "skills", p), { recursive: true });
    const abs = join(repoRoot, ".claude", "skills", p, "SKILL.md");
    await writeFile(abs, body);
    return {
      path: abs,
      displayPath: `./.claude/skills/${p}/SKILL.md`,
      kind: "skill",
      mtimeMs: Date.now(),
    };
  }

  it("does not flag skills that only use built-in tools", async () => {
    const f = await writeSkill("ok", "---\nname: ok\ntools: [Bash, Read]\n---\nbody");
    const out = await memorySkillToolsDrift.run(ctx([f]));
    expect(out).toEqual([]);
  });

  it("flags skills that reference an unknown tool name", async () => {
    const f = await writeSkill("bad", "---\nname: bad\ntools: [Bash, NonExistentTool]\n---\nbody");
    const out = await memorySkillToolsDrift.run(ctx([f]));
    expect(out).toHaveLength(1);
    expect(out[0]?.summary).toContain("NonExistentTool");
  });

  it("treats a project agent file as a valid tool reference", async () => {
    await mkdir(join(repoRoot, ".claude", "agents"), { recursive: true });
    await writeFile(join(repoRoot, ".claude", "agents", "MyAgent.md"), "x");
    const f = await writeSkill("with-agent", "---\nname: x\ntools: [Bash, MyAgent]\n---\nbody");
    const out = await memorySkillToolsDrift.run(ctx([f]));
    expect(out).toEqual([]);
  });

  it("skips when front-matter is malformed (no closing ---)", async () => {
    const f = await writeSkill("malformed", "---\nname: bad\ntools: [Bash]\nbody continues without close");
    const out = await memorySkillToolsDrift.run(ctx([f]));
    expect(out).toEqual([]);
  });

  it("ignores non-skill / non-agent files", async () => {
    const claudeMd: MemoryFile = {
      path: "/repo/CLAUDE.md",
      displayPath: "./CLAUDE.md",
      kind: "claude-md",
      mtimeMs: Date.now(),
    };
    const out = await memorySkillToolsDrift.run(ctx([claudeMd]));
    expect(out).toEqual([]);
  });
});
