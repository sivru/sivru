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

import { readFile as fsReadFile, realpath, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { extractBlocks, hashBlockContent } from "@sivru/search";

import { gitFileDirty } from "../lib/git.js";
import type { BlockEdit, CreateEdit, FeedbackPatch } from "./patch.js";

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
  /** True if the file has uncommitted changes (scoped to `repoRoot`). */
  isDirty: (absPath: string, repoRoot: string) => Promise<boolean>;
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
  | "escapes-repo" // sourcePath resolves outside the repo root (rejected)
  | "already-annotated" // create on a symbol that already has a block
  | "decl-mismatch" // create's declLine no longer holds the symbol (stale)
  | "field-absent" // the field line isn't present (adding fields is deferred)
  | "unsupported-format"; // multi-line value / list form / language (deferred)

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
  isDirty: (p, root) => gitFileDirty(root, p),
};

/** Strip a line's comment prefix (`*` / `//` / `#`), same heuristic as autofix. */
const stripComment = (l: string): string =>
  l.replace(/^\s*(?:\/\/\/|\/\/|\*|#)\s?/, "");

/** Quote a YAML scalar when it would otherwise be misparsed. A control char
 *  (newline/tab/cr) is always escaped inside double quotes so a multi-line value
 *  can never split the single source line. */
function yamlScalar(v: string): string {
  const hasControl = /[\n\r\t]/.test(v);
  // Quote anything YAML would coerce away from a string: numbers, bool/null
  // keywords, or the structural / control forms.
  const looksTyped =
    /^(true|false|yes|no|on|off|null|~)$/i.test(v) ||
    /^[-+]?(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)([eE][-+]?\d+)?$/.test(v);
  if (v === "" || hasControl || looksTyped || /^[\s]|[\s]$|[:#]|^["'\[{>|&*!%@`]/.test(v)) {
    const escaped = v
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
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

const C_LIKE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "java", "go", "rs", "c", "cc", "cpp", "h", "hpp",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 0-indexed splice position for a new block: the declaration line, walked up
 * past any contiguous decorator / annotation lines (`@Component`, `@Override`)
 * so the doc-comment lands above them, not between the decorator and its symbol.
 */
function lineAboveDecorators(lines: string[], declLine: number): number {
  let idx = declLine - 1; // 0-indexed declaration line
  while (idx > 0 && /^\s*@\w/.test(lines[idx - 1] ?? "")) {
    idx -= 1;
  }
  return idx;
}

/**
 * Build the lines of a fresh minimal `@sivru` block (role + responsibility) to
 * insert above a symbol's declaration, matching its indentation and the file's
 * doc-comment style. v1 supports C-like `/** *​/` languages; Python docstrings
 * and others are deferred.
 */
function buildBlockInsert(
  sourcePath: string,
  declLine: number,
  role: string,
  responsibility: string,
  lines: string[],
): { lines: string[] } | { reason: "unsupported-format"; detail: string } {
  const ext = sourcePath.split(".").pop()?.toLowerCase() ?? "";
  if (!C_LIKE_EXT.has(ext)) {
    return { reason: "unsupported-format", detail: `creating a block is not supported for .${ext} files yet` };
  }
  const indent = (lines[declLine - 1] ?? "").match(/^\s*/)?.[0] ?? "";
  const body = [
    "@sivru",
    "schema: 1",
    `role: ${yamlScalar(role)}`,
    `responsibility: ${yamlScalar(responsibility)}`,
    "maturity: experimental",
    "@end",
  ];
  return { lines: [`${indent}/**`, ...body.map((b) => `${indent} * ${b}`), `${indent} */`] };
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

  // Group edits AND creates by source file.
  const editsByFile = new Map<string, BlockEdit[]>();
  for (const e of patch.edits) {
    (editsByFile.get(e.sourcePath) ?? editsByFile.set(e.sourcePath, []).get(e.sourcePath)!).push(e);
  }
  const createsByFile = new Map<string, CreateEdit[]>();
  for (const c of patch.creates ?? []) {
    (createsByFile.get(c.sourcePath) ?? createsByFile.set(c.sourcePath, []).get(c.sourcePath)!).push(c);
  }

  const root = resolve(opts.repoRoot);
  const realRoot = await realpath(root).catch(() => root);
  const refuseEdit = (e: BlockEdit, status: EditStatus, detail: string): void => {
    outcomes.push({ targetNodeId: e.targetNodeId, sourcePath: e.sourcePath, field: e.edit.field, status, detail });
  };
  const refuseCreate = (c: CreateEdit, status: EditStatus, detail: string): void => {
    outcomes.push({ targetNodeId: c.targetNodeId, sourcePath: c.sourcePath, field: "(create)", status, detail });
  };

  for (const sourcePath of new Set([...editsByFile.keys(), ...createsByFile.keys()])) {
    const fileEdits = editsByFile.get(sourcePath) ?? [];
    const fileCreates = createsByFile.get(sourcePath) ?? [];
    const abs = resolve(root, sourcePath);
    // Untrusted input: lexical check (`..` / absolute), then realpath so a
    // symlink inside the repo pointing out can't smuggle a write past the guard.
    let real = abs;
    try {
      real = await realpath(abs);
    } catch {
      // file may not exist yet; lexical containment stands
    }
    if (
      (abs !== root && !abs.startsWith(root + sep)) ||
      (real !== realRoot && !real.startsWith(realRoot + sep))
    ) {
      fileEdits.forEach((e) => refuseEdit(e, "escapes-repo", "sourcePath resolves outside the repo root"));
      fileCreates.forEach((c) => refuseCreate(c, "escapes-repo", "sourcePath resolves outside the repo root"));
      continue;
    }
    let content: string;
    try {
      content = await deps.readFile(abs);
    } catch {
      fileEdits.forEach((e) => refuseEdit(e, "not-found", "file not found"));
      fileCreates.forEach((c) => refuseCreate(c, "not-found", "file not found"));
      continue;
    }
    if (opts.force !== true && (await deps.isDirty(abs, root))) {
      fileEdits.forEach((e) => refuseEdit(e, "dirty", "uncommitted changes; re-run with --force"));
      fileCreates.forEach((c) => refuseCreate(c, "dirty", "uncommitted changes; re-run with --force"));
      continue;
    }

    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);
    let mutated = false;

    // CREATES first (bottom-up by declLine so an insert can't shift a lower one).
    if (fileCreates.length > 0) {
      const existing = await deps.extract(abs, content);
      for (const c of [...fileCreates].sort((a, b) => b.declLine - a.declLine)) {
        if (existing.some((b) => b.symbolName === c.blockSymbolName && b.block !== null)) {
          refuseCreate(c, "already-annotated", `"${c.blockSymbolName}" already has a block — edit it instead`);
          continue;
        }
        // Creates aren't hash-gated like edits, so guard against a stale
        // declLine: the declaration (± a line for modifiers/decorators) must
        // still mention the symbol as a whole word — a substring match would
        // false-accept `foo` inside `foobar` or a nearby comment.
        const declWindow = [c.declLine - 2, c.declLine - 1, c.declLine].map((i) => lines[i] ?? "").join("\n");
        if (!new RegExp(`\\b${escapeRegExp(c.blockSymbolName)}\\b`).test(declWindow)) {
          refuseCreate(c, "decl-mismatch", `"${c.blockSymbolName}" is no longer at line ${c.declLine} (source changed since the explainer was generated)`);
          continue;
        }
        const ins = buildBlockInsert(sourcePath, c.declLine, c.role, c.responsibility, lines);
        if ("reason" in ins) {
          refuseCreate(c, ins.reason, ins.detail);
          continue;
        }
        // Insert ABOVE any decorators/annotations attached to the declaration —
        // a doc-comment belongs above `@Component` / `@Override`, not between it
        // and the symbol.
        const insertAt = lineAboveDecorators(lines, c.declLine);
        if (opts.dryRun === true) {
          outcomes.push({ targetNodeId: c.targetNodeId, sourcePath, field: "(create)", status: "applied", detail: `would insert a block above line ${insertAt + 1}` });
        } else {
          lines.splice(insertAt, 0, ...ins.lines);
          mutated = true;
          outcomes.push({ targetNodeId: c.targetNodeId, sourcePath, field: "(create)", status: "applied", detail: `created a block above line ${insertAt + 1}` });
        }
      }
    }

    // EDITS — re-extract from the (possibly create-mutated) content so block
    // line ranges are fresh. Apply bottom-up per block; batch per block.
    if (fileEdits.length > 0) {
      const blocks = await deps.extract(abs, mutated ? lines.join(eol) : content);
      type Job = { block: ExtractedLike; edits: BlockEdit[] };
      const jobs: Job[] = [];
      for (const e of fileEdits) {
        const named = blocks.filter((b) => b.symbolName === e.blockSymbolName && b.block !== null);
        if (named.length === 0) { refuseEdit(e, "not-found", `no @sivru block on "${e.blockSymbolName}"`); continue; }
        const matched = named.filter((b) => deps.hash(b.block) === e.blockContentHash);
        if (matched.length === 0) { refuseEdit(e, "stale", "block changed since the explainer was generated"); continue; }
        if (matched.length > 1) { refuseEdit(e, "ambiguous", "more than one identical block with this symbol name"); continue; }
        const block = matched[0]!;
        const job = jobs.find((j) => j.block === block);
        if (job) job.edits.push(e);
        else jobs.push({ block, edits: [e] });
      }
      for (const job of jobs.sort((a, b) => b.block.range.startLine - a.block.range.startLine)) {
        for (const e of job.edits) {
          const res = rewriteField(lines, job.block.range.startLine, job.block.range.endLine, e.edit);
          if ("reason" in res) {
            refuseEdit(e, res.reason, res.reason === "field-absent" ? `no "${e.edit.field}:" line in the block (adding fields is not supported yet)` : `"${e.edit.field}" uses a multi-line form (not supported yet)`);
            continue;
          }
          const prev = lines[res.lineIdx]!;
          if (opts.dryRun !== true) { lines[res.lineIdx] = res.next; mutated = true; }
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
