// Shared block-write handlers (DESIGN-0021 §Architecture). SINGLE SOURCE OF
// TRUTH for every block/feedback mutation: the HTTP routes (server/app.ts) and
// the MCP tools (cli/src/mcp-entry.ts) both call these exact functions, so the
// UI and agent surfaces can never drift. Each returns the shared HandlerResult
// envelope (result.ts).
//
// PRIVACY NOTE (DESIGN.md §5.5): local-disk only — @sivru/search block ops are
// pure filesystem; no network imports here.

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import {
  autofixFile,
  extractBlocksFromFiles,
  hashBlockContent,
  loadBlockConfig,
  serializeBlock,
  validateBlock,
  MODULE_SYMBOL_NAME,
} from "@sivru/search";
import type { AutofixResult, BlockDiagnostic, SivruBlock } from "@sivru/search";

import { realpathWithinRoot, resolveFileWithinRoot } from "../../server/path-safety.js";
import {
  appendAcknowledgment,
  appendFeedback,
  readFeedback,
  type DiagnosticRef,
  type FeedbackFilter,
  type FeedbackKind,
  type FeedbackRecord,
} from "../../feedback/index.js";
import { writeAudit, type AuditAction } from "../../audit/index.js";
import { rewriteFence } from "./fence.js";
import { err, ok, type HandlerResult } from "./result.js";

/** Per-call context shared by every handler. */
export interface HandlerContext {
  rootPath: string;
  actor: "ui" | "cli" | "mcp";
  /** The --writable gate. Read ops ignore it; write ops require it. */
  writable: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Returns a WRITABLE-DISABLED error when the gate is off, else null. */
function gate<T>(ctx: HandlerContext): HandlerResult<T> | null {
  if (!ctx.writable) {
    return err<T>(
      "SIVRU-WRITABLE-DISABLED",
      "server is read-only; restart with --writable to enable writes",
      false,
    );
  }
  return null;
}

async function audit(
  ctx: HandlerContext,
  action: AuditAction,
  filePath: string,
  detail?: string,
): Promise<void> {
  await writeAudit(ctx.rootPath, {
    schema: 1,
    timestamp: nowIso(),
    action,
    actor: ctx.actor,
    filePath,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// applyAutofix — apply the YAML-trap autofixer (E237/E238) to one file.
// ---------------------------------------------------------------------------

export interface AutofixData {
  filePath: string;
  rewrites: number;
  fixed: BlockDiagnostic[];
  remaining: BlockDiagnostic[];
}

export async function applyAutofix(
  ctx: HandlerContext,
  filePath: string,
  diagnosticCode?: string,
): Promise<HandlerResult<AutofixData>> {
  const blocked = gate<AutofixData>(ctx);
  if (blocked !== null) return blocked;

  const lexical = resolveFileWithinRoot(ctx.rootPath, filePath);
  if (lexical === null) {
    return err("SIVRU-PATH-OUTSIDE-ROOT", `filePath escapes rootPath: ${filePath}`, false);
  }
  try {
    await stat(lexical);
  } catch {
    return err("SIVRU-FILE-NOT-FOUND", `file not found: ${filePath}`, false);
  }
  // Canonicalize: reject (and never write through) a symlink that escapes root.
  const abs = await realpathWithinRoot(ctx.rootPath, lexical);
  if (abs === null) {
    return err("SIVRU-PATH-OUTSIDE-ROOT", `filePath resolves (via symlink) outside rootPath: ${filePath}`, false);
  }

  let result: AutofixResult;
  try {
    result = await autofixFile(abs);
  } catch (e) {
    return err("SIVRU-AUTOFIX-RAISED", e instanceof Error ? e.message : String(e), true);
  }

  // Single contract for re-extraction: refresh the in-memory block cache.
  await extractBlocksFromFiles([abs]);
  await audit(ctx, "autofix", filePath, diagnosticCode);

  return ok({
    filePath,
    rewrites: result.rewrites,
    fixed: result.fixed,
    remaining: result.remaining,
  });
}

// ---------------------------------------------------------------------------
// editBlock — rewrite a single block's YAML in place (form-driven editor).
// ---------------------------------------------------------------------------

export interface EditData {
  filePath: string;
  /** New on-disk mtime, so the client can use it as the next 409 baseline. */
  mtimeMs: number;
}

export async function editBlock(
  ctx: HandlerContext,
  filePath: string,
  symbol: string,
  block: SivruBlock,
  expectedMtimeMs?: number,
): Promise<HandlerResult<EditData>> {
  const blocked = gate<EditData>(ctx);
  if (blocked !== null) return blocked;

  const lexical = resolveFileWithinRoot(ctx.rootPath, filePath);
  if (lexical === null) {
    return err("SIVRU-PATH-OUTSIDE-ROOT", `filePath escapes rootPath: ${filePath}`, false);
  }
  let mtime1: number;
  try {
    mtime1 = (await stat(lexical)).mtimeMs;
  } catch {
    return err("SIVRU-FILE-NOT-FOUND", `file not found: ${filePath}`, false);
  }
  // Canonicalize: operate on the real path so we never read/write through a
  // symlink that escapes rootPath (this also guards the 409 readFile below).
  const abs = await realpathWithinRoot(ctx.rootPath, lexical);
  if (abs === null) {
    return err("SIVRU-PATH-OUTSIDE-ROOT", `filePath resolves (via symlink) outside rootPath: ${filePath}`, false);
  }

  // Client baseline conflict (the long edit window): the form was opened
  // against an older version of the file.
  if (expectedMtimeMs !== undefined && Math.round(expectedMtimeMs) !== Math.round(mtime1)) {
    const current = await readFile(abs, "utf8").catch(() => "");
    return err(
      "SIVRU-FILE-CHANGED",
      "file was modified externally; reload latest before saving",
      true,
      { mtimeMs: mtime1, content: current },
    );
  }

  // Locate the target block at its current range (catches symbol rename/move).
  const extracted = await extractBlocksFromFiles([abs]);
  const match = extracted.find((e) => (e.symbolName ?? MODULE_SYMBOL_NAME) === symbol);
  if (match === undefined) {
    return err("SIVRU-FILE-CHANGED", `symbol "${symbol}" no longer resolves to a block; re-read`, true);
  }

  // Validate the proposed block before writing.
  const config = loadBlockConfig(ctx.rootPath);
  const diagnostics = validateBlock(block, { location: match.range, config });
  if (diagnostics.some((d) => d.severity === "error")) {
    return err("SIVRU-VALIDATION-FAILED", "block failed validation", false, { diagnostics });
  }

  const content = await readFile(abs, "utf8");
  const rewrite = rewriteFence(content, match.range, serializeBlock(block));
  if (!rewrite.ok) {
    return err("SIVRU-FILE-CHANGED", rewrite.reason, true);
  }

  // Re-check mtime just before writing — guards the brief read→write window
  // against a concurrent CLI `--autofix`.
  const mtime2 = (await stat(abs)).mtimeMs;
  if (Math.round(mtime2) !== Math.round(mtime1)) {
    const current = await readFile(abs, "utf8").catch(() => "");
    return err("SIVRU-FILE-CHANGED", "file changed during save; reload latest", true, {
      mtimeMs: mtime2,
      content: current,
    });
  }

  // Atomic write: temp + rename. Clean up the temp file if the rename fails
  // (EXDEV, perms, disk full) so we never leave a stray .sivru-tmp in the repo.
  const tmp = `${abs}.sivru-tmp`;
  try {
    await writeFile(tmp, rewrite.content, "utf8");
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    return err("SIVRU-INTERNAL-ERROR", e instanceof Error ? e.message : String(e), true);
  }

  const after = await stat(abs);
  await extractBlocksFromFiles([abs]); // single contract: refresh cache + graph
  await audit(ctx, "edit", filePath, symbol);

  return ok({ filePath, mtimeMs: after.mtimeMs });
}

// ---------------------------------------------------------------------------
// Feedback + acknowledgment.
// ---------------------------------------------------------------------------

/** Authoritative content-hash for a diagnostic's block (don't trust client). */
async function resolveContentHash(rootPath: string, ref: { filePath: string; symbolName: string }): Promise<string> {
  const abs = resolveFileWithinRoot(rootPath, ref.filePath);
  if (abs === null) return "";
  try {
    const extracted = await extractBlocksFromFiles([abs]);
    const match = extracted.find(
      (e) => (e.symbolName ?? MODULE_SYMBOL_NAME) === ref.symbolName && e.block !== null,
    );
    return match?.block != null ? hashBlockContent(match.block) : "";
  } catch {
    return "";
  }
}

export interface FeedbackInput {
  code: string;
  filePath: string;
  symbolName: string;
}

/**
 * Append a feedback record. `acknowledge` also writes to the separate
 * acknowledgments file (the cheap suppression scan). false-positive/suggest go
 * to feedback.jsonl only.
 */
export async function appendFeedbackRecord(
  ctx: HandlerContext,
  kind: FeedbackKind,
  input: FeedbackInput,
  label: string,
  note?: string,
): Promise<HandlerResult<{ appended: true; contentHash: string }>> {
  const blocked = gate<{ appended: true; contentHash: string }>(ctx);
  if (blocked !== null) return blocked;

  const contentHash = await resolveContentHash(ctx.rootPath, input);
  const diagnostic: DiagnosticRef = {
    code: input.code,
    filePath: input.filePath,
    symbolName: input.symbolName,
    contentHash,
  };
  const record: FeedbackRecord = {
    schema: 1,
    timestamp: nowIso(),
    kind,
    diagnostic,
    label,
    ...(note !== undefined ? { note } : {}),
    actor: ctx.actor,
  };

  await appendFeedback(ctx.rootPath, record);
  if (kind === "acknowledge") {
    await appendAcknowledgment(ctx.rootPath, record);
  }
  await audit(ctx, "feedback", input.filePath, `${kind}:${input.code}`);

  return ok({ appended: true, contentHash });
}

/** Convenience wrapper: acknowledge a diagnostic as intentional. */
export function acknowledgeDiagnostic(
  ctx: HandlerContext,
  input: FeedbackInput,
  note?: string,
): Promise<HandlerResult<{ appended: true; contentHash: string }>> {
  return appendFeedbackRecord(ctx, "acknowledge", input, "intentional", note);
}

/** Read feedback records — NOT writable-gated; reading is always allowed. */
export async function readFeedbackRecords(
  ctx: HandlerContext,
  filter?: FeedbackFilter,
): Promise<HandlerResult<{ records: FeedbackRecord[] }>> {
  const records = await readFeedback(ctx.rootPath, filter);
  return ok({ records });
}
