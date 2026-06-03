// Append-only JSONL helpers (DESIGN-0021 slot 2).
//
// One JSON object per line, git-trackable. The append path is atomic
// (fs.appendFile, no read-modify-write) so concurrent appends never garble a
// line. The read path skips malformed lines with a structured stderr warning
// and never throws — a single bad line cannot break a read endpoint.
//
// PRIVACY NOTE (DESIGN.md §5.5): local-disk only. No network imports.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Append one record as a JSONL line, creating the parent dir if needed. */
export async function appendJsonlLine(filePath: string, record: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
}

export interface ReadJsonlResult<T> {
  records: T[];
  /** Count of lines skipped because they were not valid JSON. */
  skipped: number;
}

/**
 * Read every JSONL line from `filePath`. A missing file yields an empty result
 * (not an error). Malformed lines are skipped + counted, with one stderr
 * warning per bad line. `validate` may reject a parsed object (e.g. unknown
 * schema) by returning null — rejected lines count as skipped.
 */
export async function readJsonlLines<T>(
  filePath: string,
  validate: (parsed: unknown, lineNo: number) => T | null,
): Promise<ReadJsonlResult<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { records: [], skipped: 0 };
  }
  const records: T[] = [];
  let skipped = 0;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      process.stderr.write(`jsonl: skipped malformed line ${i + 1} in ${filePath}\n`);
      continue;
    }
    const ok = validate(parsed, i + 1);
    if (ok === null) {
      skipped++;
      continue;
    }
    records.push(ok);
  }
  return { records, skipped };
}
