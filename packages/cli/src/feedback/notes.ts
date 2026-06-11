// Freeform feedback notes → `.sivru/feedback-notes.md` (DESIGN-0018 Slice 3).
//
// A structured patch can only auto-apply structured field edits; freeform prose
// ("this is wrong because…") can't be applied deterministically without an LLM
// (deferred, DESIGN-0022). Rather than collect-and-drop it — which would quietly
// discard a reader's most nuanced feedback — we record each note here for a
// human/agent to act on, and report the count. Appends are deduped by exact
// line, so re-applying a patch never double-writes.

import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { FeedbackNote } from "./patch.js";

export interface NotesDeps {
  read?: (absPath: string) => Promise<string>; // "" when absent
  write?: (absPath: string, content: string) => Promise<void>;
}

const HEADER =
  "# Explainer feedback notes\n\n" +
  "Freeform notes exported from `sivru feedback`. These are NOT applied to source " +
  "automatically — review each and edit the relevant `@sivru` block by hand.\n";

const defaultRead = async (p: string): Promise<string> => {
  try {
    return await fsReadFile(p, "utf8");
  } catch {
    return "";
  }
};
const defaultWrite = async (p: string, c: string): Promise<void> => {
  await mkdir(dirname(p), { recursive: true });
  await fsWriteFile(p, c, "utf8");
};

function noteLine(n: FeedbackNote): string {
  const where = n.sourcePath ? ` (\`${n.sourcePath}\`)` : "";
  return `- **${n.targetNodeId}**${where}: ${n.note.replace(/\s*\n\s*/g, " ").trim()}`;
}

export interface NotesResult {
  added: number;
  path: string;
}

/** Append new notes to `.sivru/feedback-notes.md`, deduped by exact line. */
export async function appendNotes(
  notes: readonly FeedbackNote[],
  repoRoot: string,
  deps: NotesDeps = {},
): Promise<NotesResult> {
  const path = resolve(repoRoot, ".sivru", "feedback-notes.md");
  if (notes.length === 0) return { added: 0, path };
  const existing = await (deps.read ?? defaultRead)(path);
  const seen = new Set(existing.split("\n"));
  const fresh = [...new Set(notes.map(noteLine))].filter((l) => !seen.has(l));
  if (fresh.length === 0) return { added: 0, path };
  const base = existing.trim().length > 0 ? existing.replace(/\n+$/, "") : HEADER;
  await (deps.write ?? defaultWrite)(path, `${base}\n${fresh.join("\n")}\n`);
  return { added: fresh.length, path };
}
