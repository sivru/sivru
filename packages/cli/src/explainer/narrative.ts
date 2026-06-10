// System-narrative source resolution (DESIGN-0018 Slice 1, open question 1).
//
// Resolution order, first hit wins:
//   1. `.sivru/explainer.md`        — the repo-tracked narrative source the
//                                     feedback loop (Slice 3) writes back to.
//   2. ARCHITECTURE.md / README.md  — an existing repo doc, if present.
//   3. a generated stub             — so the System node is never empty.
//
// `.sivru/explainer.md` is checked FIRST: once a repo adopts it (Slice 3), it
// is the authored source of record and should win over a generic README.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type NarrativeOrigin =
  | ".sivru/explainer.md"
  | "ARCHITECTURE.md"
  | "README.md"
  | "stub";

export interface ResolvedNarrative {
  text: string;
  origin: NarrativeOrigin;
}

const STUB =
  "No system narrative yet. Add one in `.sivru/explainer.md` (or an " +
  "ARCHITECTURE.md / README.md) and re-run `sivru explain --project`.";

/** Read a repo-relative file as utf8, or null if it does not exist / can't be read. */
async function readOrNull(
  repoRoot: string,
  rel: string,
): Promise<string | null> {
  try {
    const text = await readFile(resolve(repoRoot, rel), "utf8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export interface NarrativeDeps {
  /** Override the reader (tests inject an in-memory map). */
  read?: (repoRoot: string, rel: string) => Promise<string | null>;
}

export async function resolveNarrative(
  repoRoot: string,
  deps: NarrativeDeps = {},
): Promise<ResolvedNarrative> {
  const read = deps.read ?? readOrNull;
  const order: NarrativeOrigin[] = [
    ".sivru/explainer.md",
    "ARCHITECTURE.md",
    "README.md",
  ];
  for (const rel of order) {
    const text = await read(repoRoot, rel);
    if (text !== null) return { text, origin: rel };
  }
  return { text: STUB, origin: "stub" };
}
