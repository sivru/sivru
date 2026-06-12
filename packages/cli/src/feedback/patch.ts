// The feedback patch — the contract between the explainer's in-browser annotate
// mode (export) and `sivru feedback apply` (DESIGN-0018 Slice 3).
//
// Structured field edits ONLY: every change names the exact block field and the
// new value, so apply is deterministic (no LLM, per DESIGN-0022). Freeform
// notes are recorded to `.sivru/feedback-notes.md`, never auto-written to
// source. Each edit carries the block's content hash at export time so apply
// can refuse a stale edit instead of corrupting a changed block.
//
// v1 field ops are all SINGLE-LINE value replacements (scalar set + the inline
// collaborators array), so applying one never shifts another block's line
// range. Editing multi-line invariants/decisions and list add/remove are
// deferred (they change line counts and want a structural splice).

/** A single-line, value-replacing edit to one @sivru block field. */
export type FieldOp =
  | { field: "role" | "responsibility" | "maturity"; op: "set"; value: string }
  | { field: "collaborators"; op: "set"; value: string[] };

/** The set of fields the v1 annotate UI may edit and apply can write. */
export const EDITABLE_FIELDS = ["role", "responsibility", "maturity", "collaborators"] as const;

export interface BlockEdit {
  /** Explainer node id the section was projected from (traceability only). */
  targetNodeId: string;
  /** Repo-relative POSIX path of the source file holding the block. */
  sourcePath: string;
  /** Symbol the block annotates; the module-block sentinel for top-of-file blocks. */
  blockSymbolName: string;
  /** `hashBlockContent` of the block at export — the staleness gate. */
  blockContentHash: string;
  /** The structured change. */
  edit: FieldOp;
}

/**
 * Author a NEW `@sivru` block on an un-annotated symbol — the "add intent"
 * path. Apply inserts a minimal block (role + responsibility) above the
 * symbol's declaration; the reader fills the rest later.
 */
export interface CreateEdit {
  targetNodeId: string;
  sourcePath: string;
  blockSymbolName: string;
  /** 1-indexed declaration line to insert the block above. */
  declLine: number;
  role: string;
  responsibility: string;
}

/** Feedback on the system narrative (no symbol home) → `.sivru/explainer.md`. */
export interface NarrativeEdit {
  value: string;
}

/** Freeform feedback — recorded, never applied to source. */
export interface FeedbackNote {
  targetNodeId: string;
  sourcePath?: string;
  note: string;
}

export interface FeedbackPatch {
  schema: 1;
  /** Absolute repo root the patch was generated against (apply warns on mismatch). */
  repoRoot: string;
  /** git HEAD (short) at generation time (apply warns on mismatch). */
  head: string;
  edits: BlockEdit[];
  creates?: CreateEdit[];
  narrative?: NarrativeEdit[];
  notes?: FeedbackNote[];
}

/** Parse + validate an exported patch. Throws a coded error on a bad shape. */
export function parsePatch(raw: string): FeedbackPatch {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FeedbackPatchError(`patch is not valid JSON: ${msg}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new FeedbackPatchError("patch must be a JSON object");
  }
  const p = value as Record<string, unknown>;
  if (p.schema !== 1) {
    throw new FeedbackPatchError(`unsupported patch schema: ${String(p.schema)} (expected 1)`);
  }
  if (!Array.isArray(p.edits)) {
    throw new FeedbackPatchError("patch.edits must be an array");
  }
  for (const e of p.edits as unknown[]) validateEdit(e);
  if (p.creates !== undefined) {
    if (!Array.isArray(p.creates)) throw new FeedbackPatchError("patch.creates must be an array");
    for (const c of p.creates as unknown[]) validateCreate(c);
  }
  if (p.narrative !== undefined) {
    if (!Array.isArray(p.narrative)) throw new FeedbackPatchError("patch.narrative must be an array");
    for (const n of p.narrative as unknown[]) {
      if (typeof n !== "object" || n === null || typeof (n as Record<string, unknown>).value !== "string") {
        throw new FeedbackPatchError("each narrative edit must have a string `value`");
      }
    }
  }
  if (p.notes !== undefined) {
    if (!Array.isArray(p.notes)) throw new FeedbackPatchError("patch.notes must be an array");
    for (const n of p.notes as unknown[]) {
      const note = n as Record<string, unknown>;
      if (typeof n !== "object" || n === null || typeof note.targetNodeId !== "string" || typeof note.note !== "string") {
        throw new FeedbackPatchError("each note must have string `targetNodeId` and `note`");
      }
    }
  }
  return value as FeedbackPatch;
}

function validateEdit(e: unknown): void {
  if (typeof e !== "object" || e === null) {
    throw new FeedbackPatchError("each edit must be an object");
  }
  const edit = e as Record<string, unknown>;
  for (const k of ["targetNodeId", "sourcePath", "blockSymbolName", "blockContentHash"]) {
    if (typeof edit[k] !== "string" || (edit[k] as string).length === 0) {
      throw new FeedbackPatchError(`edit.${k} must be a non-empty string`);
    }
  }
  const op = edit.edit as Record<string, unknown> | undefined;
  if (op === undefined || op.op !== "set") {
    throw new FeedbackPatchError("edit.edit.op must be \"set\"");
  }
  if (op.field === "collaborators") {
    if (!Array.isArray(op.value) || !op.value.every((v) => typeof v === "string")) {
      throw new FeedbackPatchError("collaborators value must be a string[]");
    }
  } else if (op.field === "role" || op.field === "responsibility" || op.field === "maturity") {
    if (typeof op.value !== "string") {
      throw new FeedbackPatchError(`${op.field} value must be a string`);
    }
  } else {
    throw new FeedbackPatchError(`unsupported field: ${String(op.field)}`);
  }
}

function validateCreate(c: unknown): void {
  if (typeof c !== "object" || c === null) {
    throw new FeedbackPatchError("each create must be an object");
  }
  const cr = c as Record<string, unknown>;
  for (const k of ["targetNodeId", "sourcePath", "blockSymbolName", "role", "responsibility"]) {
    if (typeof cr[k] !== "string" || (cr[k] as string).length === 0) {
      throw new FeedbackPatchError(`create.${k} must be a non-empty string`);
    }
  }
  if (typeof cr.declLine !== "number" || !Number.isInteger(cr.declLine) || cr.declLine < 1) {
    throw new FeedbackPatchError("create.declLine must be a positive integer");
  }
}

/** SIVRU-E2012 — malformed / unsupported feedback patch. */
export class FeedbackPatchError extends Error {
  readonly code = "SIVRU-E2012";
  constructor(message: string) {
    super(`SIVRU-E2012: ${message}`);
    this.name = "FeedbackPatchError";
  }
}
