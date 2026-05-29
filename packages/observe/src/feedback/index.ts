// Feedback + acknowledgment record shapes and their JSONL stores
// (DESIGN-0021 §"Feedback record shape"). Append-only, git-trackable, local.
//
// `.sivru/feedback.jsonl`        — all feedback kinds (acknowledge / false-
//                                  positive / suggest), the tuning signal.
// `.sivru/acknowledgments.jsonl` — the acknowledge subset, stored separately so
//                                  the diagnostic-suppression read path is a
//                                  single cheap file scan (no filtering).

import { join } from "node:path";

import { appendJsonlLine, readJsonlLines } from "../jsonl.js";

export type FeedbackKind = "acknowledge" | "false-positive" | "suggest";
export type FeedbackActor = "ui" | "cli" | "mcp";

/** Identifies the diagnostic a record is about; content-hash keys invalidation. */
export interface DiagnosticRef {
  code: string;
  filePath: string;
  symbolName: string;
  contentHash: string;
}

export interface FeedbackRecord {
  schema: 1;
  timestamp: string;
  kind: FeedbackKind;
  diagnostic: DiagnosticRef;
  /** intentional | false-positive | suggested-rewrite, etc. */
  label: string;
  note?: string;
  actor: FeedbackActor;
}

const CURRENT_SCHEMA = 1;

export function feedbackPath(rootPath: string): string {
  return join(rootPath, ".sivru", "feedback.jsonl");
}

export function acknowledgmentsPath(rootPath: string): string {
  return join(rootPath, ".sivru", "acknowledgments.jsonl");
}

/**
 * Validate + normalize a parsed line to a FeedbackRecord. Mandatory `schema`
 * field; unknown future schemas are rejected (skipped) with a warning rather
 * than crashing the read. Forward-compatible per DESIGN-0021 §"Schema migration".
 */
function normalizeRecord(parsed: unknown): FeedbackRecord | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o["schema"] !== CURRENT_SCHEMA) {
    process.stderr.write(`feedback: skipping record with unsupported schema ${String(o["schema"])}\n`);
    return null;
  }
  const d = o["diagnostic"];
  if (d === null || typeof d !== "object") return null;
  return parsed as FeedbackRecord;
}

/** Append a feedback record to `.sivru/feedback.jsonl`. */
export async function appendFeedback(rootPath: string, record: FeedbackRecord): Promise<void> {
  await appendJsonlLine(feedbackPath(rootPath), record);
}

export interface FeedbackFilter {
  kind?: FeedbackKind;
  code?: string;
}

/** Read feedback records (newest order preserved as appended); never throws. */
export async function readFeedback(
  rootPath: string,
  filter?: FeedbackFilter,
): Promise<FeedbackRecord[]> {
  const { records } = await readJsonlLines<FeedbackRecord>(feedbackPath(rootPath), normalizeRecord);
  if (filter === undefined) return records;
  return records.filter(
    (r) =>
      (filter.kind === undefined || r.kind === filter.kind) &&
      (filter.code === undefined || r.diagnostic.code === filter.code),
  );
}

/** Append an acknowledgment (a `kind: "acknowledge"` record) to its own file. */
export async function appendAcknowledgment(rootPath: string, record: FeedbackRecord): Promise<void> {
  await appendJsonlLine(acknowledgmentsPath(rootPath), record);
}

/** Read acknowledgments — single-file scan for cheap diagnostic suppression. */
export async function readAcknowledgments(rootPath: string): Promise<FeedbackRecord[]> {
  const { records } = await readJsonlLines<FeedbackRecord>(
    acknowledgmentsPath(rootPath),
    normalizeRecord,
  );
  return records;
}
