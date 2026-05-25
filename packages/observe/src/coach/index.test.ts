// runCheckup integration tests against seeded git repos.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILT_IN_CHECKS, runCheckup } from "./index.js";
import { runCmd } from "./exec.js";

async function gitAvailable(): Promise<boolean> {
  return (await runCmd("git", ["--version"])).ok;
}

async function newRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sivru-runcheckup-"));
  await runCmd("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await runCmd("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runCmd("git", ["config", "user.name", "test"], { cwd: dir });
  await runCmd("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}

async function commit(dir: string, files: Record<string, string>, msg: string): Promise<void> {
  for (const [p, body] of Object.entries(files)) {
    const abs = join(dir, p);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  await runCmd("git", ["add", "-A"], { cwd: dir });
  await runCmd("git", ["commit", "-q", "-m", msg], { cwd: dir });
}

describe("BUILT_IN_CHECKS", () => {
  it("exposes the three v0.9 checks in stable order", () => {
    expect(BUILT_IN_CHECKS.map((c) => c.id)).toEqual([
      "memory-claude-age",
      "memory-dead-reference",
      "memory-skill-tools-drift",
    ]);
  });
});

describe("runCheckup — integration", () => {
  let tmp: string;

  beforeEach(async () => {
    if (!(await gitAvailable())) return;
    tmp = await newRepo();
  });

  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  });

  it("repo-fresh: no findings", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, {
      "CLAUDE.md": "# fresh\nSee `package.json`.",
      "package.json": "{}",
    }, "init");
    const report = await runCheckup(tmp, { homeDir: tmp });
    expect(report.findings).toEqual([]);
    expect(report.files).toHaveLength(1);
  });

  it("repo-stale (mtime mode): emits aged finding when --no-git is used and file is old", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, { "package.json": "{}" }, "init");
    // Write CLAUDE.md with a very old mtime so the day-floor triggers even
    // without git history.
    const claudePath = join(tmp, "CLAUDE.md");
    await writeFile(claudePath, "# stale\n");
    const oldTime = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const { utimes } = await import("node:fs/promises");
    await utimes(claudePath, oldTime, oldTime);

    const report = await runCheckup(tmp, { noGit: true, homeDir: tmp });
    const ageFinding = report.findings.find((f) => f.checkId === "memory-claude-age");
    expect(ageFinding).toBeDefined();
    expect(ageFinding?.severity).toBe("info");
  });

  it("dead-reference fires on a broken inline path", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, {
      "CLAUDE.md": "See `does/not/exist.ts` for details.",
    }, "init");
    const report = await runCheckup(tmp, { homeDir: tmp });
    const drf = report.findings.find((f) => f.checkId === "memory-dead-reference");
    expect(drf).toBeDefined();
    expect(drf?.summary).toContain("does/not/exist.ts");
  });

  it("skill-tools-drift fires on a SKILL.md with an unknown tool", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, {
      ".claude/skills/foo/SKILL.md": "---\nname: foo\ntools: [Bash, NotARealTool]\n---\nbody\n",
    }, "init");
    const report = await runCheckup(tmp, { homeDir: tmp });
    const std = report.findings.find((f) => f.checkId === "memory-skill-tools-drift");
    expect(std).toBeDefined();
    expect(std?.summary).toContain("NotARealTool");
  });

  it("the --check filter restricts to one check id", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, {
      "CLAUDE.md": "See `nope/here.ts`.",
      ".claude/skills/foo/SKILL.md": "---\ntools: [Bogus]\n---\n",
    }, "init");
    const report = await runCheckup(tmp, {
      check: ["memory-dead-reference"],
      homeDir: tmp,
    });
    for (const f of report.findings) {
      expect(f.checkId).toBe("memory-dead-reference");
    }
  });

  it("severityOverrides remap the finding severity", async () => {
    if (!(await gitAvailable())) return;
    await mkdir(join(tmp, ".sivru"), { recursive: true });
    await writeFile(
      join(tmp, ".sivru", "checkup.json"),
      JSON.stringify({ severityOverrides: { "memory-dead-reference": "error" } }),
    );
    await commit(tmp, {
      "CLAUDE.md": "See `nope/here.ts`.",
    }, "init");
    const report = await runCheckup(tmp, { homeDir: tmp });
    const drf = report.findings.find((f) => f.checkId === "memory-dead-reference");
    expect(drf?.severity).toBe("error");
  });

  it("disabled in config removes the check from the run", async () => {
    if (!(await gitAvailable())) return;
    await mkdir(join(tmp, ".sivru"), { recursive: true });
    await writeFile(
      join(tmp, ".sivru", "checkup.json"),
      JSON.stringify({ disabled: ["memory-dead-reference"] }),
    );
    await commit(tmp, {
      "CLAUDE.md": "See `nope/here.ts`.",
    }, "init");
    const report = await runCheckup(tmp, { homeDir: tmp });
    expect(report.findings.find((f) => f.checkId === "memory-dead-reference")).toBeUndefined();
  });

  it("D6a delight: aged finding includes 'Biggest changes since:' preview", async () => {
    if (!(await gitAvailable())) return;
    // Lower thresholds to 0 so the file flags immediately. Adds a few
    // commits across two segments so the diff bucket has content.
    await mkdir(join(tmp, ".sivru"), { recursive: true });
    await writeFile(
      join(tmp, ".sivru", "checkup.json"),
      JSON.stringify({ ageDays: 0, ageCommits: 0 }),
    );
    await commit(tmp, { "CLAUDE.md": "# anchor" }, "init claude");
    // Add commits across two first-path segments so D6a has content to bucket.
    await commit(tmp, { "src/a.ts": "1", "src/b.ts": "2" }, "src");
    await commit(tmp, { "docs/x.md": "y" }, "docs");

    const report = await runCheckup(tmp, { homeDir: tmp });
    const aged = report.findings.find((f) => f.checkId === "memory-claude-age");
    expect(aged).toBeDefined();
    expect(aged?.summary).toMatch(/Biggest changes since:/);
    expect(aged?.summary).toMatch(/(src|docs)\//);
  });

  it("D6b delight: dead-reference includes 'May have been renamed to' on a known rename", async () => {
    if (!(await gitAvailable())) return;
    await commit(tmp, { "scanner.ts": "export const x = 1;\nexport const y = 2;\n" }, "init");
    await runCmd("git", ["mv", "scanner.ts", "audit.ts"], { cwd: tmp });
    await runCmd("git", ["commit", "-q", "-m", "rename"], { cwd: tmp });
    await commit(tmp, { "CLAUDE.md": "See `scanner.ts` for details." }, "add claude");

    const report = await runCheckup(tmp, { homeDir: tmp });
    const drf = report.findings.find((f) => f.checkId === "memory-dead-reference");
    expect(drf).toBeDefined();
    expect(drf?.summary).toMatch(/scanner\.ts/);
    expect(drf?.summary).toMatch(/May have been renamed to.*audit\.ts/);
  });

  it("emits SIVRU-E244 diagnostic when run against a non-git dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sivru-nogit-"));
    await writeFile(join(dir, "CLAUDE.md"), "# x");
    const report = await runCheckup(dir, { homeDir: dir });
    const diag = report.diagnostics.find((d) => d.code === "SIVRU-E244");
    expect(diag).toBeDefined();
    await rm(dir, { recursive: true, force: true });
  });
});
