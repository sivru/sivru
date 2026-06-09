import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBundledSkill } from "../skill-asset.js";
import { runSkill } from "./skill.js";

// `runSkill` writes into `~/.claude/skills` (user scope) or
// `<gitroot>/.claude/skills` (--project). Tests redirect the user scope by
// overriding $HOME, and drive --project against a throwaway git repo.

let homeDir: string;
let projectRepo: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "sivru-skill-home-"));
  projectRepo = await mkdtemp(join(tmpdir(), "sivru-skill-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: projectRepo });
  origHome = process.env.HOME;
  process.env.HOME = homeDir;
  // os.homedir() reads USERPROFILE on Windows, not HOME — redirect both so the
  // user scope points at the temp dir on every platform.
  origUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = homeDir;
});

afterEach(async () => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  await rm(homeDir, { recursive: true, force: true });
  await rm(projectRepo, { recursive: true, force: true });
});

type Captured = { stdout: string; stderr: string; restore: () => void };

function captureIO(): Captured {
  const captured: Captured = { stdout: "", stderr: "", restore: () => {} };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErr;
  };
  return captured;
}

async function run(...argv: string[]): Promise<{ code: number } & Captured> {
  const cap = captureIO();
  let code: number;
  try {
    code = await runSkill(["skill", ...argv]);
  } finally {
    cap.restore();
  }
  return { code, ...cap };
}

const userSkillFile = (): string =>
  join(homeDir, ".claude", "skills", "sivru", "SKILL.md");

describe("runSkill — install", () => {
  it("fresh install writes the bundled skill to the user scope", async () => {
    const r = await run("install");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(existsSync(userSkillFile())).toBe(true);
    expect(readFileSync(userSkillFile(), "utf8")).toBe(readBundledSkill());
    expect(r.stdout).toMatch(/installed/);
  });

  it("re-install over an identical file says 'already current', no notice", async () => {
    await run("install");
    const r = await run("install");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/already current/);
    expect(r.stdout).not.toMatch(/overwritten/);
  });

  it("re-install over an edited sivru skill overwrites and notices it", async () => {
    await run("install");
    const edited =
      readBundledSkill() + "\n<!-- my local edit -->\n";
    writeFileSync(userSkillFile(), edited);
    const r = await run("install");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/your edited SKILL\.md was overwritten/);
    expect(readFileSync(userSkillFile(), "utf8")).toBe(readBundledSkill());
  });

  it("refuses to overwrite a non-sivru file at the path", async () => {
    const file = userSkillFile();
    mkdirSync(join(homeDir, ".claude", "skills", "sivru"), {
      recursive: true,
    });
    writeFileSync(file, "# someone else's notes\n");
    const r = await run("install");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/non-sivru file/);
    expect(readFileSync(file, "utf8")).toBe("# someone else's notes\n");
  });

  it("--force overwrites a non-sivru file at the path", async () => {
    const file = userSkillFile();
    mkdirSync(join(homeDir, ".claude", "skills", "sivru"), {
      recursive: true,
    });
    writeFileSync(file, "# someone else's notes\n");
    const r = await run("install", "--force");
    expect(r.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(readBundledSkill());
  });

  it("--project installs into the git repo root", async () => {
    const r = await run("install", "--project", "--cwd", projectRepo);
    expect(r.code).toBe(0);
    const projFile = join(
      projectRepo,
      ".claude",
      "skills",
      "sivru",
      "SKILL.md",
    );
    expect(existsSync(projFile)).toBe(true);
    expect(readFileSync(projFile, "utf8")).toBe(readBundledSkill());
  });

  it("--project outside a git repo fails with a clear error", async () => {
    const notRepo = await mkdtemp(join(tmpdir(), "sivru-skill-norepo-"));
    try {
      const r = await run("install", "--project", "--cwd", notRepo);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/git repository/);
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  it("notes a cross-scope collision when a copy exists in the other scope", async () => {
    // Pre-seed a project-scope copy, then install at user scope.
    const projFile = join(
      projectRepo,
      ".claude",
      "skills",
      "sivru",
      "SKILL.md",
    );
    mkdirSync(join(projectRepo, ".claude", "skills", "sivru"), {
      recursive: true,
    });
    writeFileSync(projFile, readBundledSkill());
    const r = await run("install", "--cwd", projectRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/project-scope copy also exists/);
  });
});

describe("runSkill — uninstall", () => {
  it("removes an installed skill", async () => {
    await run("install");
    expect(existsSync(userSkillFile())).toBe(true);
    const r = await run("uninstall");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/removed/);
    expect(existsSync(userSkillFile())).toBe(false);
  });

  it("is idempotent when nothing is installed", async () => {
    const r = await run("uninstall");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to remove/);
  });
});

describe("runSkill — usage", () => {
  it("exits 2 on a missing subcommand", async () => {
    const r = await run();
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Usage/);
  });

  it("exits 2 on an unknown subcommand", async () => {
    const r = await run("frobnicate");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown or missing subcommand/);
  });
});
