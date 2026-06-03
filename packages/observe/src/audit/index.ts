// Write audit trail (DESIGN-0021 §Observability). Distinct from feedback.jsonl
// (user-labeled data): audit records "this write happened, when, by whom, to
// which file." Always written when --writable is on; no flag to disable.
//
// Per-day files at `.sivru/audit/YYYY-MM-DD.jsonl`. A bounded retention sweep
// deletes files older than N days (default 7). Local-disk only.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { appendJsonlLine } from "../jsonl.js";

export type AuditAction = "autofix" | "edit" | "acknowledge" | "feedback";

export interface AuditRecord {
  schema: 1;
  timestamp: string;
  action: AuditAction;
  actor: "ui" | "cli" | "mcp";
  filePath: string;
  /** Optional detail, e.g. the diagnostic code an autofix targeted. */
  detail?: string;
}

const AUDIT_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function auditDir(rootPath: string): string {
  return join(rootPath, ".sivru", "audit");
}

/** `YYYY-MM-DD` in UTC from an ISO timestamp (the record's own time). */
export function auditDay(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/** Append an audit record to today's per-day file. */
export async function writeAudit(rootPath: string, record: AuditRecord): Promise<void> {
  const file = join(auditDir(rootPath), `${auditDay(record.timestamp)}.jsonl`);
  await appendJsonlLine(file, record);
}

/**
 * Delete audit files older than `retentionDays` (default 7), comparing the
 * filename date against `nowMs`. Bounded + predictable; missing dir is a no-op.
 * Returns the number of files removed.
 */
export async function sweepAuditRetention(
  rootPath: string,
  retentionDays = 7,
  nowMs: number = Date.now(),
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(auditDir(rootPath));
  } catch {
    return 0;
  }
  const cutoff = nowMs - retentionDays * 86_400_000;
  let removed = 0;
  for (const name of entries) {
    const m = AUDIT_FILE_RE.exec(name);
    if (m === null) continue;
    const dayMs = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(dayMs) && dayMs < cutoff) {
      try {
        await rm(join(auditDir(rootPath), name), { force: true });
        removed++;
      } catch {
        // best-effort; leave it for the next sweep
      }
    }
  }
  return removed;
}
