// `sivru skill install` / `sivru skill uninstall` — manage the installed
// Claude Code skill that teaches an agent when to route to sivru's MCP
// tools versus grep.
//
// v0.4 is the minimal installer (DESIGN-0003 §3): `--force`-by-default for an
// edited sivru skill, a one-line notice when it overwrote local edits, and a
// cross-scope collision note. The marker / content-hash / SKILL.md.new
// edit-safety subsystem is deferred to v0.6.
//
//   install flow:
//     resolve scope ── user (~/.claude/skills) | --project (<gitroot>/.claude/skills)
//          │
//          ▼
//     read bundled SKILL.md ──(missing)──▶ fail loud (corrupt @sivru/cli)
//          │
//          ▼
//     target exists? ──no──▶ fresh write
//          │ yes
//          ▼
//     looks like a sivru skill? ──no──▶ refuse (report; --force overrides)
//          │ yes
//          ▼
//     identical to bundled? ──yes──▶ already current, no notice
//          │ no
//          ▼
//     overwrite + print "your edited SKILL.md was overwritten"

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { looksLikeSivruSkill, readBundledSkill } from "../skill-asset.js";

const SKILL_DIR_NAME = "sivru";
const SKILL_FILE_NAME = "SKILL.md";

type Scope = "user" | "project";

type ParsedArgs = {
  sub: "install" | "uninstall";
  scope: Scope;
  force: boolean;
  cwd: string;
};

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const sub = argv[1];
  if (sub !== "install" && sub !== "uninstall") {
    return { error: `unknown or missing subcommand: ${sub ?? "(none)"}` };
  }

  let scope: Scope = "user";
  let force = false;
  let cwd = process.cwd();

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--project") {
      scope = "project";
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--cwd") {
      const next = argv[i + 1];
      if (next === undefined) return { error: "--cwd requires a directory" };
      cwd = next;
      i++;
    } else {
      return { error: `unknown flag: ${arg}` };
    }
  }

  return { sub, scope, force, cwd };
}

/** Git repo root for `cwd`. Throws a clear error when `cwd` is not in a repo. */
function gitRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `--project requires being inside a git repository (cwd: ${cwd})`,
    );
  }
}

/** Base `…/.claude/skills` directory for a scope. */
function skillsBaseDir(scope: Scope, cwd: string): string {
  if (scope === "project") {
    return join(gitRoot(cwd), ".claude", "skills");
  }
  return join(homedir(), ".claude", "skills");
}

/** The other scope's installed-skill path, or null if it cannot be resolved
 *  (e.g. checking the project scope while not inside a git repo). */
function otherScopeSkillFile(scope: Scope, cwd: string): string | null {
  const other: Scope = scope === "user" ? "project" : "user";
  try {
    return join(skillsBaseDir(other, cwd), SKILL_DIR_NAME, SKILL_FILE_NAME);
  } catch {
    return null;
  }
}

/** Translate a filesystem error into a named, actionable message. */
function fsErrorMessage(err: unknown, path: string): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EACCES") return `permission denied writing ${path}`;
  if (code === "ENOSPC") return `no space left on device writing ${path}`;
  return `${(err as Error).message ?? String(err)}`;
}

function runInstall(args: ParsedArgs): number {
  // The bundled asset first — a missing asset is a corrupt install, surfaced
  // before we touch the target directory.
  let bundled: string;
  try {
    bundled = readBundledSkill();
  } catch (err) {
    process.stderr.write(`sivru skill install: ${(err as Error).message}\n`);
    return 1;
  }

  let baseDir: string;
  try {
    baseDir = skillsBaseDir(args.scope, args.cwd);
  } catch (err) {
    process.stderr.write(`sivru skill install: ${(err as Error).message}\n`);
    return 1;
  }

  const targetDir = join(baseDir, SKILL_DIR_NAME);
  const targetFile = join(targetDir, SKILL_FILE_NAME);

  let editedNotice = false;

  if (existsSync(targetFile)) {
    let existing: string;
    try {
      existing = readFileSync(targetFile, "utf8");
    } catch (err) {
      process.stderr.write(
        `sivru skill install: cannot read ${targetFile}: ${(err as Error).message}\n`,
      );
      return 1;
    }

    if (!looksLikeSivruSkill(existing)) {
      if (!args.force) {
        process.stderr.write(
          `sivru skill install: a non-sivru file already exists at ` +
            `${targetFile}; refusing to overwrite it. Pass --force to ` +
            `replace it.\n`,
        );
        return 1;
      }
      // --force: fall through and overwrite the unrelated file.
    } else if (existing === bundled) {
      process.stdout.write(`sivru skill: already current at ${targetFile}\n`);
      reportCollision(args, targetFile);
      return 0;
    } else {
      // An edited sivru skill. --force is the default; note that we
      // overwrote the user's edits.
      editedNotice = true;
    }
  }

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `sivru skill install: cannot create ${targetDir}: ${fsErrorMessage(err, targetDir)}\n`,
    );
    return 1;
  }

  try {
    writeFileSync(targetFile, bundled);
  } catch (err) {
    process.stderr.write(
      `sivru skill install: ${fsErrorMessage(err, targetFile)}\n`,
    );
    return 1;
  }

  if (editedNotice) {
    process.stdout.write(
      "sivru skill: note — your edited SKILL.md was overwritten with the " +
        "bundled version.\n",
    );
  }
  process.stdout.write(
    `sivru skill installed: ${targetFile}\n` +
      `  edit this file to customize the routing policy.\n`,
  );

  reportCollision(args, targetFile);
  return 0;
}

/** Print a one-line note if a copy of the skill exists in the other scope. */
function reportCollision(args: ParsedArgs, installedFile: string): void {
  const other = otherScopeSkillFile(args.scope, args.cwd);
  if (other && other !== installedFile && existsSync(other)) {
    const otherScope = args.scope === "user" ? "project" : "user";
    process.stdout.write(
      `sivru skill: note — a ${otherScope}-scope copy also exists at ` +
        `${other}; Claude Code may load whichever wins precedence.\n`,
    );
  }
}

function runUninstall(args: ParsedArgs): number {
  let baseDir: string;
  try {
    baseDir = skillsBaseDir(args.scope, args.cwd);
  } catch (err) {
    process.stderr.write(`sivru skill uninstall: ${(err as Error).message}\n`);
    return 1;
  }

  const targetDir = join(baseDir, SKILL_DIR_NAME);
  const targetFile = join(targetDir, SKILL_FILE_NAME);

  if (!existsSync(targetFile)) {
    process.stdout.write(
      `sivru skill: nothing to remove (${targetFile} not present)\n`,
    );
    return 0;
  }

  try {
    rmSync(targetFile);
    // Remove the sivru/ directory too, but only if it is now empty.
    if (existsSync(targetDir) && readdirSync(targetDir).length === 0) {
      rmdirSync(targetDir);
    }
  } catch (err) {
    process.stderr.write(
      `sivru skill uninstall: ${fsErrorMessage(err, targetFile)}\n`,
    );
    return 1;
  }

  process.stdout.write(`sivru skill removed: ${targetFile}\n`);
  return 0;
}

const USAGE = [
  "sivru skill — manage the installed Claude Code routing skill",
  "",
  "Usage:",
  "  sivru skill install [--project] [--force]",
  "  sivru skill uninstall [--project]",
  "",
  "  --project   Install into <git repo root>/.claude/skills/ instead of",
  "              the default ~/.claude/skills/",
  "  --force     Overwrite even a non-sivru file at the target path",
  "  --cwd <dir> Directory --project resolves the git root from",
  "              (default: the current directory)",
].join("\n");

export async function runSkill(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru skill: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }

  if (parsed.sub === "install") return runInstall(parsed);
  return runUninstall(parsed);
}
