// `sivru feedback apply <patch.json>` — apply an explainer feedback patch to
// source @sivru blocks / .sivru narrative (DESIGN-0018 Slice 3).
//
// A distinct verb, NOT a flag on `explain`: `explain` is a read-only projection;
// this mutates source, so it gets its own command. Safety lives in the apply
// engine (hash-gated, dirty-guarded, never silently drops); this layer parses
// the patch, warns on repo/HEAD drift, orchestrates the three writers, prints a
// summary, and sets a CI-gateable exit code (nonzero if any edit was refused).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { applyBlockEdits } from "../feedback/apply.js";
import { applyNarrative } from "../feedback/narrative.js";
import { appendNotes } from "../feedback/notes.js";
import { FeedbackPatchError, parsePatch } from "../feedback/patch.js";
import { gitHeadShort } from "../lib/git.js";

const USAGE = [
  "sivru feedback apply <patch.json> [--dry-run] [--force] [--repo=<dir>]",
  "",
  "  Apply an explainer feedback patch (exported from `sivru explain --html`)",
  "  to the @sivru blocks / .sivru/explainer.md it was projected from.",
  "",
  "  --dry-run     Show the per-block before/after; write nothing",
  "  --force       Apply even to files with uncommitted changes",
  "  --repo=<dir>  Repo root (default: the patch's repoRoot, else cwd)",
].join("\n");

export async function runFeedback(argv: readonly string[]): Promise<number> {
  if (argv[0] !== "apply") {
    process.stderr.write(`sivru feedback: unknown subcommand "${argv[0] ?? ""}"\n\n${USAGE}\n`);
    return 1;
  }

  let patchPath: string | null = null;
  let dryRun = false;
  let force = false;
  let repoOverride: string | null = null;
  for (const a of argv.slice(1)) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("--repo=")) repoOverride = a.slice("--repo=".length);
    else if (a.startsWith("--")) {
      process.stderr.write(`sivru feedback apply: unknown flag ${a}\n`);
      return 1;
    } else if (patchPath === null) patchPath = a;
    else {
      process.stderr.write(`sivru feedback apply: unexpected argument ${a}\n`);
      return 1;
    }
  }
  if (patchPath === null) {
    process.stderr.write(`sivru feedback apply: missing <patch.json>\n\n${USAGE}\n`);
    return 1;
  }

  let patch;
  try {
    patch = parsePatch(await readFile(patchPath, "utf8"));
  } catch (err) {
    if (err instanceof FeedbackPatchError) {
      process.stderr.write(`sivru feedback apply: ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sivru feedback apply: cannot read patch: ${msg}\n`);
    return 1;
  }

  const repoRoot = resolve(repoOverride ?? patch.repoRoot ?? process.cwd());

  // Warn (don't fail) on repo / HEAD drift — the per-block hash gate is the
  // real safety net; this just helps the user understand a wall of refusals.
  const head = await gitHeadShort(repoRoot);
  if (head !== "" && patch.head && head !== patch.head) {
    process.stderr.write(
      `sivru feedback apply: note — patch was generated at ${patch.head}, repo is at ${head}; ` +
        `stale edits will be refused.\n`,
    );
  }

  const result = await applyBlockEdits(patch, { repoRoot, dryRun, force });
  // Narrative + notes are skipped under --dry-run (it writes nothing, anywhere).
  const narrative = dryRun
    ? { written: false, path: "" }
    : await applyNarrative(patch.narrative ?? [], repoRoot);
  const notes = dryRun ? { added: 0, path: "" } : await appendNotes(patch.notes ?? [], repoRoot);

  // Summary.
  const applied = result.outcomes.filter((o) => o.status === "applied");
  const refused = result.outcomes.filter((o) => o.status !== "applied");
  for (const o of applied) {
    const p = o.preview;
    process.stdout.write(
      dryRun
        ? `  would set ${o.field} in ${o.sourcePath} (line ${p?.line})\n`
        : `  set ${o.field} in ${o.sourcePath} (line ${p?.line})\n`,
    );
  }
  for (const o of refused) {
    process.stdout.write(`  REFUSED ${o.field} in ${o.sourcePath} — ${o.status}: ${o.detail ?? ""}\n`);
  }
  if (narrative.written) process.stdout.write(`  narrative → ${narrative.path}\n`);
  if (notes.added > 0) process.stdout.write(`  ${notes.added} note(s) → ${notes.path}\n`);
  process.stdout.write(
    `${dryRun ? "[dry-run] " : ""}${applied.length} applied, ${refused.length} refused` +
      `${result.filesWritten.length ? `, ${result.filesWritten.length} file(s) written` : ""}.\n`,
  );

  // Nonzero exit if anything was refused (so CI / scripts can gate).
  return refused.length > 0 ? 1 : 0;
}
