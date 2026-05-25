// LAST_VERIFIED: 2026-05-24 against Claude Code's documented public tools.
// Source: Anthropic Claude Code docs (https://docs.claude.com/en/docs/claude-code).
//
// DESIGN-0005 §1 + A4: built-in Claude Code tool list, pinned at release
// time. A newly-added Claude Code tool will false-positive-flag in
// `memory-skill-tools-drift` until a sivru release updates this set —
// v0.7 accepts that lag as an honest cost. The `LAST_VERIFIED:` header
// is asserted by `known-tools.test.ts` so it can't silently rot.
//
// v0.7.x+ may add a user-side `knownTools` config field as an escape
// hatch (already implied by §8 layer-2 extensibility).

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Canonical Claude Code built-in tool names as of LAST_VERIFIED above.
 * Order doesn't matter; we look up via Set.
 */
export const BUILT_IN_CLAUDE_CODE_TOOLS: readonly string[] = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "ListMcpResources",
  "McpResource",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "ReadMcpResource",
  "SlashCommand",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;

const BUILT_IN_SET: ReadonlySet<string> = new Set(BUILT_IN_CLAUDE_CODE_TOOLS);

/** True if `name` is a documented Claude Code built-in tool. */
export function isBuiltInTool(name: string): boolean {
  return BUILT_IN_SET.has(name);
}

/**
 * Discover subagent names from `.claude/agents/*.md` filenames in both
 * the project and user-global locations. Filename without `.md` is the
 * canonical agent name (matches Claude Code's resolution rule).
 *
 * Returns the union of project + user-global names. Silently returns an
 * empty set when neither directory exists or is unreadable; the caller
 * (skill-tools-drift) treats unknown names as drift, which is the
 * conservative direction.
 */
export async function discoverAgentNames(
  repoRoot: string,
  homeDir: string,
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of [join(repoRoot, ".claude", "agents"), join(homeDir, ".claude", "agents")]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // ENOENT / EACCES — agents directory just isn't present.
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      names.add(entry.slice(0, -".md".length));
    }
  }
  return names;
}
