// DESIGN-0021 slot 1 — "Blocks touched" derivation for the Replay tab.
//
// Pure helpers: from a session's events, find the files the agent edited; then
// cross-reference against the repo's block graph to surface which blocks sit
// on touched files. File-level granularity (the read-only event stream does
// not carry edited line ranges, so true range-overlap is a slot-2 follow-up).

import type { BlockNodeDetail } from "./api";
import type { SivruEvent } from "./types";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Distinct file paths the agent edited in this session (best-effort). */
export function editedFilePaths(events: readonly SivruEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    if (e.tool === undefined || !EDIT_TOOLS.has(e.tool)) continue;
    const input = e.input;
    if (input === null || typeof input !== "object") continue;
    const fp = (input as Record<string, unknown>)["file_path"];
    if (typeof fp === "string" && fp.length > 0) out.add(fp);
  }
  return [...out];
}

/** True when two paths refer to the same file (abs-vs-abs or abs-vs-rel). */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  // Treat one path as a suffix of the other only when the shorter side is a
  // multi-segment path (contains "/"). A bare basename ("index.ts") must match
  // exactly — otherwise two same-named files in different directories collide.
  if (a.includes("/") && b.endsWith(`/${a}`)) return true;
  if (b.includes("/") && a.endsWith(`/${b}`)) return true;
  return false;
}

/** Block nodes whose source file was edited in the session. */
export function blocksTouched(
  nodes: readonly BlockNodeDetail[],
  editedPaths: readonly string[],
): BlockNodeDetail[] {
  return nodes.filter((n) => editedPaths.some((e) => samePath(n.filePath, e)));
}
