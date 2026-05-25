// Tests for the known-tools registry.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_IN_CLAUDE_CODE_TOOLS, discoverAgentNames, isBuiltInTool } from "./known-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("BUILT_IN_CLAUDE_CODE_TOOLS", () => {
  it("includes the canonical core tools", () => {
    for (const name of ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Agent", "WebFetch", "WebSearch"]) {
      expect(isBuiltInTool(name)).toBe(true);
    }
  });

  it("rejects unknown names", () => {
    expect(isBuiltInTool("DefinitelyNotATool")).toBe(false);
    expect(isBuiltInTool("")).toBe(false);
  });

  it("has no duplicates", () => {
    const set = new Set(BUILT_IN_CLAUDE_CODE_TOOLS);
    expect(set.size).toBe(BUILT_IN_CLAUDE_CODE_TOOLS.length);
  });
});

describe("known-tools.ts LAST_VERIFIED header", () => {
  it("carries the CI-asserted maintenance header (DESIGN-0005 A4)", async () => {
    const file = await readFile(join(HERE, "known-tools.ts"), "utf8");
    // Header must be of the form: `// LAST_VERIFIED: YYYY-MM-DD against Claude Code ...`
    expect(file).toMatch(/^\/\/ LAST_VERIFIED: \d{4}-\d{2}-\d{2} /m);
  });
});

describe("discoverAgentNames", () => {
  it("returns an empty set when neither directory exists", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sivru-known-tools-"));
    const out = await discoverAgentNames(join(tmp, "repo"), join(tmp, "home"));
    expect(out.size).toBe(0);
  });

  it("discovers project + user-global agent files by filename stem", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sivru-known-tools-"));
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    await mkdir(join(repo, ".claude", "agents"), { recursive: true });
    await mkdir(join(home, ".claude", "agents"), { recursive: true });
    await writeFile(join(repo, ".claude", "agents", "Custom.md"), "x");
    await writeFile(join(home, ".claude", "agents", "Personal.md"), "x");
    await writeFile(join(repo, ".claude", "agents", "not-an-agent.txt"), "x");
    const out = await discoverAgentNames(repo, home);
    expect(out.has("Custom")).toBe(true);
    expect(out.has("Personal")).toBe(true);
    expect(out.has("not-an-agent")).toBe(false);
  });
});
