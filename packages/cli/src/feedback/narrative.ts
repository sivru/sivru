// Narrative feedback → `.sivru/explainer.md` (DESIGN-0018 Slice 3).
//
// Feedback on the system narrative has no symbol home, so it lands in the
// repo-tracked narrative source the projection already prefers (resolveNarrative
// checks `.sivru/explainer.md` first). We OWN this file: the narrative edits are
// the new narrative, written whole — idempotent by construction (re-applying the
// same patch writes identical bytes, no append/dedupe problem).

import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { NarrativeEdit } from "./patch.js";

export interface NarrativeDeps {
  /** Write the file (creating `.sivru/` if needed). */
  write?: (absPath: string, content: string) => Promise<void>;
}

const defaultWrite = async (absPath: string, content: string): Promise<void> => {
  await mkdir(dirname(absPath), { recursive: true });
  await fsWriteFile(absPath, content, "utf8");
};

export interface NarrativeResult {
  written: boolean;
  path: string;
}

/** Write narrative edits to `.sivru/explainer.md` (no-op when there are none). */
export async function applyNarrative(
  edits: readonly NarrativeEdit[],
  repoRoot: string,
  deps: NarrativeDeps = {},
): Promise<NarrativeResult> {
  const path = resolve(repoRoot, ".sivru", "explainer.md");
  if (edits.length === 0) return { written: false, path };
  const content = edits.map((e) => e.value.trim()).filter((v) => v.length > 0).join("\n\n") + "\n";
  await (deps.write ?? defaultWrite)(path, content);
  return { written: true, path };
}
