// Apply a feedback patch to source `@sivru` blocks (DESIGN-0018 Slice 3).
//
// SAFETY is the whole point — never silently corrupt source:
//   - locate the block by symbolName, DISAMBIGUATE by content hash;
//   - refuse a stale edit (block changed since export) instead of writing the
//     wrong block — report it, never drop it silently;
//   - edit only the targeted field's single line, preserving its comment prefix
//     and every other byte (autofix-style line rewrite, NOT serializeBlock
//     re-emit, which has no prefix and canonicalizes / loses formatting);
//   - batch all edits for one block into one read-modify-write keyed off the
//     pre-edit hash (so a second edit to the same block isn't self-stale-d);
//   - v1 ops are single-line replacements → no line-count change → other blocks
//     and code stay byte-identical;
//   - refuse a file with uncommitted changes unless --force;
//   - preserve the file's EOL.

import { execFile } from "node:child_process";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { extractBlocks, hashBlockContent } from "@sivru/search";

import type { BlockEdit, FeedbackPatch } from "./patch.js";

const execFileAsync = promisify(execFile);

type ExtractedLike = {
  symbolName?: string;
  block: unknown;
  /** 1-indexed inclusive line range of the block fence. */
  range: { startLine: number; endLine: number };
};

export interface ApplyDeps {
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  extract: (absPath: string, content: string) => Promise<ExtractedLike[]>;
  hash: (block: unknown) => string;
  /** True if the file has uncommitted changes. */
  isDirty: (absPath: string) => Promise<boolean>;
}

export interface ApplyOptions {
  repoRoot: string;
  dryRun?: boolean;
  force?: boolean;
  deps?: Partial<ApplyDeps>;
}

export type EditStatus =
  | "applied"
  | "stale" // block changed since export (hash mismatch)
  | "not-found" // no block with that symbol
  | "ambiguous" // >1 block matches symbol AND hash
  | "dirty" // file has uncommitted changes and no --force
  | "field-absent" // the field line isn't present (adding fields is deferred)
  | "unsupported-format"; // multi-line value / list form (deferred)

export interface EditOutcome {
  targetNodeId: string;
  sourcePath: string;
  field: string;
  status: EditStatus;
  detail?: string;
  /** dry-run: the line before/after (1-indexed line number, old, new). */
  preview?: { line: number; before: string; after: string };
}

export interface ApplyResult {
  outcomes: EditOutcome[];
  filesWritten: string[];
  /** false if ANY block edit was not applied. */
  ok: boolean;
}

const defaultDeps: ApplyDeps = {
  readFile: (p) => fsReadFile(p, "utf8"),
  writeFile: (p, c) => fsWriteFile(p, c, "utf8"),
  extract: async (p, content) =>
    (await extractBlocks(p, { content })) as unknown as ExtractedLike[],
  hash: (b) => hashBlockContent(b),
  isDirty: async (p) => {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", p]);
      return stdout.trim().length > 0;
    } catch {
      return false; // not a git repo → treat as clean (force not required)
    }
  },
};

/** Strip a line's comment prefix (`*` / `//` / `#`), same heuristic as autofix. */
const stripComment = (l: string): string =>
  l.replace(/^\s*(?:\/\/\/|\/\/|\*|#)\s?/, "");

/** Quote a YAML scalar only when it would otherwise be misparsed. */
function yamlScalar(v: string): string {
  if (v === "" || /^[\s]|[\s]$|[:#]|^["'\[{>|&*!%@`]/.test(v)) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return v;
}

function inlineCollaborators(items: string[]): string {
  return `[${items.map((i) => (/[:#,\[\]"']/.test(i) ? yamlScalar(i) : i)).join(", ")}]`;
}

/** Rewrite one field's line in place. Returns the new line, or a refusal reason. */
function rewriteField(
  lines: string[],
  startLine: number,
  endLine: number,
  edit: BlockEdit["edit"],
): { lineIdx: number; next: string } | { reason: "field-absent" | "unsupported-format" } {
  for (let i = startLine; i <= endLine; i++) {
    const idx = i - 1;
    const line = lines[idx];
    if (line === undefined) continue;
    const stripped = stripComment(line);
    if (!stripped.startsWith(`${edit.field}:`)) continue;
    const prefix = line.slice(0, line.length - stripped.length);
    if (edit.field === "collaborators") {
      // Only the inline-array form is line-count-safe; a multi-line list isn't.
      if (!stripped.includes("[")) return { reason: "unsupported-format" };
      return { lineIdx: idx, next: `${prefix}collaborators: ${inlineCollaborators(edit.value)}` };
    }
    // Scalar: a `field: |` / `>` block scalar spans lines — refuse it.
    const after = stripped.slice(edit.field.length + 1).trim();
    if (after === "|" || after === ">" || after.startsWith("|") || after.startsWith(">")) {
      return { reason: "unsupported-format" };
    }
    return { lineIdx: idx, next: `${prefix}${edit.field}: ${yamlScalar(edit.value)}` };
  }
  return { reason: "field-absent" };
}

/**
 * Apply the patch's block edits. Narrative and notes are handled by their own
 * writers (see narrative.ts / notes.ts); this function owns only source-block
 * mutation and its safety.
 */
export async function applyBlockEdits(
  patch: FeedbackPatch,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const deps: ApplyDeps = { ...defaultDeps, ...opts.deps };
  const outcomes: EditOutcome[] = [];
  const filesWritten: string[] = [];

  // Group edits by source file.
  const byFile = new Map<string, BlockEdit[]>();
  for (const e of patch.edits) {
    (byFile.get(e.sourcePath) ?? byFile.set(e.sourcePath, []).get(e.sourcePath)!).push(e);
  }

  for (const [sourcePath, fileEdits] of byFile) {
    const abs = resolve(opts.repoRoot, sourcePath);
    let content: string;
    try {
      content = await deps.readFile(abs);
    } catch {
      for (const e of fileEdits) {
        outcomes.push({ targetNodeId: e.targetNodeId, sourcePath, field: e.edit.field, status: "not-found", detail: "file not found" });
      }
      continue;
    }
    if (opts.force !== true && (await deps.isDirty(abs))) {
      for (const e of fileEdits) {
        outcomes.push({ targetNodeId: e.targetNodeId, sourcePath, field: e.edit.field, status: "dirty", detail: "uncommitted changes; re-run with --force" });
      }
      continue;
    }

    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);
    const blocks = await deps.extract(abs, content);

    // Resolve the target block per edit (symbolName + hash), batch by block, and
    // apply bottom-up so a (future, line-count-changing) edit can't shift ranges.
    type Job = { block: ExtractedLike; edits: BlockEdit[] };
    const jobs: Job[] = [];
    const refuse = (e: BlockEdit, status: EditStatus, detail: string): void => {
      outcomes.push({ targetNodeId: e.targetNodeId, sourcePath, field: e.edit.field, status, detail });
    };
    for (const e of fileEdits) {
      const named = blocks.filter((b) => b.symbolName === e.blockSymbolName && b.block !== null);
      if (named.length === 0) {
        refuse(e, "not-found", `no @sivru block on "${e.blockSymbolName}"`);
        continue;
      }
      const matched = named.filter((b) => deps.hash(b.block) === e.blockContentHash);
      if (matched.length === 0) {
        refuse(e, "stale", "block changed since the explainer was generated");
        continue;
      }
      if (matched.length > 1) {
        refuse(e, "ambiguous", "more than one identical block with this symbol name");
        continue;
      }
      const block = matched[0]!;
      const job = jobs.find((j) => j.block === block);
      if (job) job.edits.push(e);
      else jobs.push({ block, edits: [e] });
    }

    let mutated = false;
    for (const job of jobs.sort((a, b) => b.block.range.startLine - a.block.range.startLine)) {
      for (const e of job.edits) {
        const res = rewriteField(lines, job.block.range.startLine, job.block.range.endLine, e.edit);
        if ("reason" in res) {
          refuse(e, res.reason, res.reason === "field-absent" ? `no "${e.edit.field}:" line in the block (adding fields is not supported yet)` : `"${e.edit.field}" uses a multi-line form (not supported yet)`);
          continue;
        }
        const prev = lines[res.lineIdx]!;
        if (opts.dryRun === true) {
          outcomes.push({ targetNodeId: e.targetNodeId, sourcePath, field: e.edit.field, status: "applied", preview: { line: res.lineIdx + 1, before: prev, after: res.next } });
        } else {
          lines[res.lineIdx] = res.next;
          mutated = true;
          outcomes.push({ targetNodeId: e.targetNodeId, sourcePath, field: e.edit.field, status: "applied", preview: { line: res.lineIdx + 1, before: prev, after: res.next } });
        }
      }
    }

    if (mutated && opts.dryRun !== true) {
      await deps.writeFile(abs, lines.join(eol));
      filesWritten.push(sourcePath);
    }
  }

  const ok = outcomes.every((o) => o.status === "applied");
  return { outcomes, filesWritten, ok };
}
