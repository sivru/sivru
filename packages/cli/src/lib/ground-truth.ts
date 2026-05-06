// Derive (query, edited_files) ground-truth pairs from a Claude Code
// session's events. The "right answer" for a query is the set of files
// the agent actually touched (Edit / Write / MultiEdit / Read) in the
// turns following that query and before the next one.
//
// This is the IR-correct anchor for the personal-bench: instead of
// asking "how compact was sivru's output?" we ask "did sivru retrieve
// the file the agent ultimately needed?". Recall@5 / MRR over these
// pairs ranks embedders by quality, not by output size.
//
// The extraction is best-effort: a session in which the agent only
// answered a question (no file edits) yields zero ground-truth files
// for that query — those queries get scored on tokens-saved only.

import { resolve, sep } from "node:path";
import type { SivruEvent } from "@sivrujs/observe";

export type QueryWithGroundTruth = {
  query: string;
  /** How the query was inferred. Search-call queries are highest signal. */
  source: "search_call" | "user_message";
  /** Index of the query event within the session — ties for sort stability. */
  eventIndex: number;
  /**
   * Files the agent touched after this query, before the next one.
   * Project-root-relative paths. Empty when the agent didn't touch
   * anything (which is the common case for "yes go ahead" messages).
   */
  relevantFiles: string[];
};

const FILE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "Read",
  "NotebookEdit",
]);

const MIN_QUERY_CHARS = 6;
const MAX_QUERY_CHARS = 200;

function isSivruSearch(tool: string): boolean {
  return tool.toLowerCase().replace(/[^a-z0-9]/g, "").includes("sivrusearch");
}

function fileFromToolInput(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const fp = (input as { file_path?: unknown }).file_path;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
}

function isQueryEvent(e: SivruEvent): boolean {
  if (
    e.kind === "tool_use" &&
    typeof e.tool === "string" &&
    isSivruSearch(e.tool)
  ) {
    return true;
  }
  if (e.kind === "user_message" && typeof e.text === "string") {
    const cleaned = e.text.trim();
    if (cleaned.length === 0) return false;
    if (cleaned.startsWith("[")) return false; // system markers
    return true;
  }
  return false;
}

function extractQueryString(
  e: SivruEvent,
): { text: string; source: "search_call" | "user_message" } | null {
  if (e.kind === "tool_use" && typeof e.tool === "string" && isSivruSearch(e.tool)) {
    const input = e.input;
    if (input !== null && typeof input === "object") {
      const q = (input as { query?: unknown }).query;
      if (typeof q === "string" && q.trim().length > 0) {
        return { text: q.trim(), source: "search_call" };
      }
    }
    return null;
  }
  if (e.kind === "user_message" && typeof e.text === "string") {
    const cleaned = e.text.replace(/\s+/g, " ").trim();
    if (cleaned.length === 0 || cleaned.startsWith("[")) return null;
    const firstSentence =
      cleaned.match(/^[^.?!]{1,200}[.?!]?/)?.[0] ?? cleaned.slice(0, MAX_QUERY_CHARS);
    const truncated =
      firstSentence.length > MAX_QUERY_CHARS
        ? firstSentence.slice(0, MAX_QUERY_CHARS).trim()
        : firstSentence.trim();
    if (truncated.length < MIN_QUERY_CHARS) return null;
    return { text: truncated, source: "user_message" };
  }
  return null;
}

/**
 * Best-effort path normalization: convert an absolute file_path to a
 * project-root-relative path. Returns null when the file is outside
 * the project root (sivru can't index it anyway).
 *
 * macOS /private/var vs /var symlink prefixes are handled by the
 * caller realpath'ing both sides before passing in; otherwise the
 * comparison is plain string-prefix.
 */
export function relativizePath(
  absPath: string,
  projectRoot: string,
): string | null {
  const root = resolve(projectRoot);
  const abs = resolve(absPath);
  if (abs === root) return null;
  if (abs === root + sep) return null;
  if (!abs.startsWith(root + sep)) return null;
  return abs.slice(root.length + 1);
}

/**
 * Walk a session's events and emit one ground-truth record per query.
 * The relevantFiles set is the union of file_path arguments across all
 * Edit / Write / MultiEdit / Read tool_use events between this query
 * and the next.
 */
export function extractGroundTruth(
  events: readonly SivruEvent[],
  projectRoot: string,
): QueryWithGroundTruth[] {
  const queryIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (isQueryEvent(events[i]!)) queryIndices.push(i);
  }
  if (queryIndices.length === 0) return [];

  const out: QueryWithGroundTruth[] = [];
  for (let qi = 0; qi < queryIndices.length; qi++) {
    const start = queryIndices[qi]!;
    const end =
      qi + 1 < queryIndices.length ? queryIndices[qi + 1]! : events.length;
    const queryEvent = events[start]!;
    const parsed = extractQueryString(queryEvent);
    if (parsed === null) continue;

    const seen = new Set<string>();
    const relevantFiles: string[] = [];
    for (let i = start + 1; i < end; i++) {
      const e = events[i]!;
      if (e.kind !== "tool_use") continue;
      if (typeof e.tool !== "string" || !FILE_TOOLS.has(e.tool)) continue;
      const abs = fileFromToolInput(e.input);
      if (abs === null) continue;
      const rel = relativizePath(abs, projectRoot);
      if (rel === null) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      relevantFiles.push(rel);
    }

    out.push({
      query: parsed.text,
      source: parsed.source,
      eventIndex: start,
      relevantFiles,
    });
  }
  return out;
}

/**
 * Heuristic "is this query likely to retrieve code?" — used to filter
 * noisy user-message queries when no real `sivru.search` calls are
 * available. Search-call queries are always kept; this only gates
 * user-message queries.
 *
 * A query is entity-shaped when it contains:
 *   - CamelCase / PascalCase identifier (`SomeClass`, `getUserById`)
 *   - snake_case identifier (`auth_token`)
 *   - dotted identifier (`user.email`, `auth/login.ts`)
 *   - common code-search trigger word (function, class, error, etc.)
 */
export function isEntityShapedQuery(query: string): boolean {
  if (/[A-Z][a-z]+[A-Z][a-z]/.test(query)) return true; // SomeClass
  if (/\b[a-z]+_[a-z_]+\b/.test(query)) return true; // snake_case
  if (/\b[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]+/.test(query)) return true; // a.b
  if (
    /\b(function|class|method|component|hook|api|endpoint|route|handler|interface|type|enum|module|test|spec|config|error|exception|import|export|package|service|controller|repository|entity|schema|migration|migration|middleware)\b/i.test(
      query,
    )
  ) {
    return true;
  }
  return false;
}
