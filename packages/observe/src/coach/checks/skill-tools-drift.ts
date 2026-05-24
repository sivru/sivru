// memory-skill-tools-drift (DESIGN-0005 §1 + §3 + D4).
//
// Validate the front-matter `tools:` field on SKILL.md and agent files.
// Each name in the field must be either a documented Claude Code built-
// in tool (`known-tools.ts`) or a discoverable subagent
// (`.claude/agents/*.md` in project or user-global).
//
// Malformed YAML front-matter → skip front-matter; document body is
// still scanned by `dead-reference`. We don't shell out to a YAML
// parser; a hand-rolled extractor handles the only shapes Claude Code
// uses (`tools: [A, B]` and the block-sequence form).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import type { AuditContext, AuditFinding, MemoryCheck } from "../types.js";
import { discoverAgentNames, isBuiltInTool } from "../known-tools.js";

export const memorySkillToolsDrift: MemoryCheck = {
  id: "memory-skill-tools-drift",
  description:
    "Front-matter `tools:` entries in SKILL.md / agent files that name neither a Claude Code built-in tool nor a discovered subagent.",
  defaultSeverity: "warning",
  appliesTo: ["skill", "agent"],

  async run(ctx: AuditContext): Promise<AuditFinding[]> {
    const home = homedir();
    const agentNames = await discoverAgentNames(ctx.repoRoot, home);
    const out: AuditFinding[] = [];

    for (const file of ctx.memoryFiles) {
      if (file.unreadable === true) continue;
      if (file.kind !== "skill" && file.kind !== "agent") continue;

      const text = await safeRead(file.path);
      if (text === null) continue;

      const fm = extractFrontMatter(text);
      if (fm === null) continue;

      const tools = parseToolsField(fm.body);
      if (tools === null) continue;

      // fm.lineOffset is the 1-indexed line of the first front-matter
      // content line — i.e. the line right after the opening `---`.
      // The `tools:` key may land further into the front matter; we
      // attribute findings to the first content line for stability.
      for (const tool of tools) {
        if (isBuiltInTool(tool)) continue;
        if (agentNames.has(tool)) continue;
        out.push({
          checkId: memorySkillToolsDrift.id,
          severity: memorySkillToolsDrift.defaultSeverity,
          filePath: file.path,
          line: fm.lineOffset,
          summary: `${file.displayPath} front-matter lists tool \`${tool}\` — not a built-in Claude Code tool and no \`.claude/agents/${tool}.md\` found.`,
          data: { tool },
        });
      }
    }
    return out;
  },
};

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

interface FrontMatter {
  body: string;
  /** 1-indexed line of the first front-matter content line (after opening `---`). */
  lineOffset: number;
}

/**
 * Pull the leading `---\n...\n---` block. Returns null when no
 * front-matter is present or the closing `---` is missing.
 */
function extractFrontMatter(text: string): FrontMatter | null {
  // Tolerate a leading BOM and an initial blank line, but the opening
  // `---` must be on the first non-empty line of the file.
  const noBom = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = noBom.split(/\r?\n/);
  if (lines.length === 0 || (lines[0] ?? "").trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      const body = lines.slice(1, i).join("\n");
      return { body, lineOffset: 2 };
    }
  }
  return null;
}

/**
 * Parse the `tools:` entry. Accepts:
 *   tools: [A, B, C]
 *   tools:
 *     - A
 *     - B
 * Returns null when the field is missing or malformed.
 */
export function parseToolsField(body: string): string[] | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Flow-style: `tools: [A, B]`
    const flow = /^tools\s*:\s*\[(.*)\]\s*$/.exec(line);
    if (flow !== null) {
      const inner = flow[1] ?? "";
      return inner
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
    }
    // Block-style: `tools:` followed by `- A` lines.
    if (/^tools\s*:\s*$/.test(line)) {
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? "";
        const m = /^\s*-\s*(.+?)\s*$/.exec(next);
        if (m === null) {
          // A non-list-item line ends the block; allow leading whitespace
          // on a continuation key/value line to mean "end of list".
          if (/^\s*$/.test(next)) continue;
          // If it's another key at the same indent, end the list.
          if (/^[^\s-].*:/.test(next)) break;
          break;
        }
        const item = stripQuotes(m[1] ?? "").trim();
        if (item.length > 0) items.push(item);
      }
      return items;
    }
  }
  return null;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}
