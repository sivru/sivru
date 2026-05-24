// Memory-file discovery (DESIGN-0005 §5).
//
// Walks the documented Claude Code memory locations and classifies each
// file. Uses `node:fs/promises` only; never shells out. Project files
// rank above user-global files in the returned list (stable sort).
//
// Globbing depth cap: 3 segments below `.claude/` — matches the
// documented Claude Code conventions, avoids runaway walks on
// misconfigured trees.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import type { MemoryFile, MemoryFileKind } from "./types.js";

const SKILLS_GLOB_FILE = "SKILL.md";
const MAX_DEPTH_BELOW_CLAUDE = 3;

interface FoundFile {
  absPath: string;
  kind: MemoryFileKind;
  /** "repo" | "home" — controls displayPath rendering and sort order. */
  scope: "repo" | "home";
}

interface DiscoverDeps {
  /** Overridable for tests; defaults to `os.homedir()`. */
  homeDir?: string;
}

/**
 * Discover every memory file under `repoRoot` and the user-global
 * `~/.claude/` tree. Returns repo files first, then home-global files;
 * each group is alpha-sorted by absolute path.
 *
 * Project-vs-user-global shadowing: both files are returned (no
 * de-duplication). Each gets its own `displayPath` so the user can
 * disambiguate; findings fire on each independently.
 */
export async function discoverMemoryFiles(
  repoRoot: string,
  deps: DiscoverDeps = {},
): Promise<MemoryFile[]> {
  const home = deps.homeDir ?? homedir();
  const found: FoundFile[] = [];

  // Project — CLAUDE.md + CLAUDE.local.md at the repo root.
  for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
    const p = join(repoRoot, name);
    if (await isFile(p)) found.push({ absPath: p, kind: "claude-md", scope: "repo" });
  }
  // Project — .claude/skills/**/SKILL.md (depth cap 3 below .claude/).
  for (const p of await walkSkills(join(repoRoot, ".claude", "skills"))) {
    found.push({ absPath: p, kind: "skill", scope: "repo" });
  }
  // Project — .claude/agents/**/*.md (depth cap 3 below .claude/).
  for (const p of await walkAgents(join(repoRoot, ".claude", "agents"))) {
    found.push({ absPath: p, kind: "agent", scope: "repo" });
  }

  // User-global mirrors.
  const homeClaudeMd = join(home, ".claude", "CLAUDE.md");
  if (await isFile(homeClaudeMd)) {
    found.push({ absPath: homeClaudeMd, kind: "claude-md", scope: "home" });
  }
  for (const p of await walkSkills(join(home, ".claude", "skills"))) {
    found.push({ absPath: p, kind: "skill", scope: "home" });
  }
  for (const p of await walkAgents(join(home, ".claude", "agents"))) {
    found.push({ absPath: p, kind: "agent", scope: "home" });
  }

  // Stable sort: scope first (repo before home), then alphabetical
  // by absolute path within each scope.
  found.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "repo" ? -1 : 1;
    return a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0;
  });

  const out: MemoryFile[] = [];
  for (const f of found) {
    const display = f.scope === "repo"
      ? "./" + relative(repoRoot, f.absPath).split("\\").join("/")
      : "~/" + relative(home, f.absPath).split("\\").join("/");
    const file: MemoryFile = {
      path: f.absPath,
      displayPath: display,
      kind: f.kind,
      mtimeMs: 0,
    };
    try {
      const st = await stat(f.absPath);
      file.mtimeMs = st.mtimeMs;
    } catch {
      // File vanished between discovery and stat — extremely rare.
      // Mark as unreadable so the user sees the slot.
      file.unreadable = true;
    }
    out.push(file);
  }
  return out;
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Walk `<root>` for `SKILL.md` files. `<root>` is conventionally
 * `<...>/.claude/skills/` — the depth cap counts segments below the
 * `.claude/` directory (so `.claude/skills/foo/SKILL.md` is depth 3
 * and accepted).
 */
async function walkSkills(root: string): Promise<string[]> {
  return walkForFile(root, SKILLS_GLOB_FILE, /*startDepth*/ 1);
}

/**
 * Walk `<root>` for any `*.md` file. `<root>` is conventionally
 * `<...>/.claude/agents/`. Same depth-cap rules as walkSkills.
 */
async function walkAgents(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkAnyMd(root, /*startDepth*/ 1, out);
  return out;
}

async function walkForFile(
  dir: string,
  basename: string,
  depthBelowClaude: number,
): Promise<string[]> {
  const out: string[] = [];
  if (depthBelowClaude > MAX_DEPTH_BELOW_CLAUDE) return out;
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name === basename) {
      out.push(full);
    } else if (e.isDirectory()) {
      out.push(...(await walkForFile(full, basename, depthBelowClaude + 1)));
    }
  }
  return out;
}

async function walkAnyMd(
  dir: string,
  depthBelowClaude: number,
  out: string[],
): Promise<void> {
  if (depthBelowClaude > MAX_DEPTH_BELOW_CLAUDE) return;
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    } else if (e.isDirectory()) {
      await walkAnyMd(full, depthBelowClaude + 1, out);
    }
  }
}
