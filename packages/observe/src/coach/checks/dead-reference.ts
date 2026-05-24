// memory-dead-reference (DESIGN-0005 §3b).
//
// Find inline-code spans and markdown link targets inside memory files
// that look like file paths but don't resolve on disk. Lines inside
// fenced code blocks are ignored (CommonMark §4.3 + §4.4 fences:
// triple-backtick, triple-tilde, and 4-space-indented).
//
// FP control: the "looks like a path" filter keeps obvious paths in
// (path-separator OR known extension) and bare identifiers out (a bare
// word like `runScan` doesn't qualify). Reference-style links
// (`[text][id]` with a separate `[id]: target` definition) are NOT
// scanned at v0.9 — uncommon in real memory files; tracked as an open
// question for v0.10.

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type {
  AuditContext,
  AuditFinding,
  MemoryCheck,
  MemoryFile,
} from "../types.js";
import { readFile } from "node:fs/promises";

const MAX_FILE_BYTES = 200 * 1024;

interface PathCandidate {
  /** The raw string as written in the file. */
  raw: string;
  /** 1-indexed line number. */
  line: number;
}

interface ScanResult {
  candidates: PathCandidate[];
  /** True when the file was larger than MAX_FILE_BYTES and only the prefix was scanned. */
  truncated: boolean;
}

export const memoryDeadReference: MemoryCheck = {
  id: "memory-dead-reference",
  description:
    "Inline-code path mentions in CLAUDE.md / SKILL.md / agent files that do not resolve to a file on disk today.",
  defaultSeverity: "warning",
  appliesTo: ["*"],

  async run(ctx: AuditContext): Promise<AuditFinding[]> {
    const home = homedir();
    const out: AuditFinding[] = [];

    for (const file of ctx.memoryFiles) {
      if (file.unreadable === true) continue;
      const text = await readFileBounded(file.path);
      if (text === null) continue;

      const result = scanForPathCandidates(text.text);
      for (const cand of result.candidates) {
        const filtered = filterAndNormalize(cand.raw, ctx.config.pathExtensions);
        if (filtered === null) continue;

        const resolved = resolveCandidate(filtered, file, ctx, home);
        if (resolved === null) continue; // skip unresolvable (e.g. relative in user-global)

        if (await pathExists(resolved)) continue;

        // The skipPaths check: a configured glob hides the finding. We
        // do a literal match (not a glob library) — `skipPaths` is
        // typically short and exact matches cover the real-world cases.
        if (ctx.config.skipPaths.includes(filtered)) continue;

        out.push({
          checkId: memoryDeadReference.id,
          severity: memoryDeadReference.defaultSeverity,
          filePath: file.path,
          line: cand.line,
          summary: `${file.displayPath}:${cand.line} references \`${filtered}\` — no such file in the repo today.`,
          detail: `Resolved path: ${resolved}`,
          data: { reference: filtered, resolved },
        });
      }

      if (result.truncated) {
        out.push({
          checkId: memoryDeadReference.id,
          severity: "warning",
          filePath: file.path,
          summary: `${file.displayPath} exceeds the 200KB scan ceiling — only the first 200KB was checked.`,
          detail: "SIVRU-E242: file too large; dead-reference results are partial.",
          data: { code: "SIVRU-E242" },
        });
      }
    }
    return out;
  },
};

async function readFileBounded(
  path: string,
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const buf = await readFile(path);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return { text: buf.subarray(0, MAX_FILE_BYTES).toString("utf8"), truncated: true };
    }
    return { text: buf.toString("utf8"), truncated: false };
  } catch {
    return null;
  }
}

/**
 * Scan markdown source for inline-code spans and markdown link targets,
 * skipping content inside fenced or indented code blocks per CommonMark.
 *
 * Returns 1-indexed line numbers. Multi-line inline-code spans are
 * attributed to the line they opened on.
 */
export function scanForPathCandidates(text: string): ScanResult {
  const candidates: PathCandidate[] = [];
  const lines = text.split(/\r?\n/);
  let inFenceBacktick = false;
  let inFenceTilde = false;
  let inIndentedBlock = false;
  let prevLineBlank = true; // start-of-file counts as "after a blank line"

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Fence open/close: a line whose trim starts with at least 3 of the
    // fence char counts. We only handle the canonical opener (no info
    // string check) — close-fence semantics match.
    if (!inIndentedBlock) {
      if (inFenceBacktick) {
        if (/^`{3,}\s*$/.test(trimmed)) inFenceBacktick = false;
        prevLineBlank = trimmed.length === 0;
        continue;
      }
      if (inFenceTilde) {
        if (/^~{3,}\s*$/.test(trimmed)) inFenceTilde = false;
        prevLineBlank = trimmed.length === 0;
        continue;
      }
      if (/^`{3,}/.test(trimmed)) {
        inFenceBacktick = true;
        prevLineBlank = false;
        continue;
      }
      if (/^~{3,}/.test(trimmed)) {
        inFenceTilde = true;
        prevLineBlank = false;
        continue;
      }
    }

    // Indented code block: opens when a line starts with 4 spaces / 1
    // tab AND the previous line was blank (CommonMark §4.4). Closes on
    // the first non-blank, non-indented line.
    const isIndented = /^( {4,}|\t)/.test(line) && line.trim().length > 0;
    if (inIndentedBlock) {
      if (line.trim().length === 0) {
        // Blank line stays part of the block; defer the close decision
        // to the next non-blank line.
        prevLineBlank = true;
        continue;
      }
      if (!isIndented) {
        inIndentedBlock = false;
        // Fall through to scan this line.
      } else {
        continue;
      }
    } else if (isIndented && prevLineBlank) {
      inIndentedBlock = true;
      prevLineBlank = false;
      continue;
    }

    // Inline-code spans on this line. Greedy match for backtick-runs;
    // matching runs of equal length close the span (CommonMark inline).
    const oneIdx = i + 1;
    extractInlineCode(line, oneIdx, candidates);
    extractMarkdownLinks(line, oneIdx, candidates);

    prevLineBlank = trimmed.length === 0;
  }
  return { candidates, truncated: false };
}

/**
 * Match `` `...` `` and `` `` ...`` `` spans on a single line. Nested
 * backticks inside an inline span match equal-length runs.
 */
function extractInlineCode(
  line: string,
  oneIdx: number,
  out: PathCandidate[],
): void {
  let pos = 0;
  while (pos < line.length) {
    const openMatch = /(`+)/.exec(line.slice(pos));
    if (openMatch === null) return;
    const openRun = openMatch[1] ?? "";
    const openStart = pos + (openMatch.index ?? 0);
    const contentStart = openStart + openRun.length;
    // Look for a closing run of the same length.
    const closeRe = new RegExp(`\`{${openRun.length}}`);
    const closeMatch = closeRe.exec(line.slice(contentStart));
    if (closeMatch === null) return;
    const contentEnd = contentStart + (closeMatch.index ?? 0);
    const span = line.slice(contentStart, contentEnd);
    // CommonMark unwraps a single leading/trailing space if both are
    // present — keeps `` ` foo ` `` rendering as `foo`. We mirror that.
    const unwrapped = span.length >= 2 && span.startsWith(" ") && span.endsWith(" ")
      ? span.slice(1, -1)
      : span;
    if (unwrapped.length > 0) {
      out.push({ raw: unwrapped, line: oneIdx });
    }
    pos = contentEnd + openRun.length;
  }
}

/**
 * Match `[text](target)` and capture the target. Skips reference-style
 * links and bare auto-links. Targets that begin with a known URL scheme
 * (http(s)://, mailto:, etc.) are skipped — they aren't file paths.
 */
function extractMarkdownLinks(
  line: string,
  oneIdx: number,
  out: PathCandidate[],
): void {
  const re = /\[[^\]]*\]\(([^)]+?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const target = (m[1] ?? "").trim();
    if (target.length === 0) continue;
    if (/^[a-z][a-z0-9+.-]*:/.test(target)) continue; // url scheme
    if (target.startsWith("#")) continue; // pure anchor
    out.push({ raw: target, line: oneIdx });
  }
}

const KNOWN_FALLBACK_EXTENSIONS = new Set<string>([
  ".ts", ".tsx", ".js", ".jsx", ".md", ".json", ".yaml", ".yml",
  ".sh", ".py", ".go", ".rs", ".java",
]);

/**
 * Apply the "looks like a path" filter and normalize. Returns null when
 * the candidate doesn't qualify. Strips trailing `#anchor` / `?query`.
 */
export function filterAndNormalize(
  raw: string,
  pathExtensions: readonly string[],
): string | null {
  let s = raw;
  // Whitespace-containing strings are almost never paths.
  if (/\s/.test(s)) return null;
  // Strip fragment / query if present.
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) s = s.slice(0, hashIdx);
  const queryIdx = s.indexOf("?");
  if (queryIdx >= 0) s = s.slice(0, queryIdx);
  if (s.length === 0) return null;

  const startsLikePath = s.startsWith("~/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("/");
  const hasSeparator = s.includes("/") && !startsLikePath;
  const exts = pathExtensions.length > 0 ? new Set(pathExtensions) : KNOWN_FALLBACK_EXTENSIONS;
  const lower = s.toLowerCase();
  const hasKnownExt = lowerEndsWithAny(lower, exts);

  if (!startsLikePath && !hasSeparator && !hasKnownExt) return null;
  return s;
}

function lowerEndsWithAny(s: string, exts: ReadonlySet<string>): boolean {
  for (const ext of exts) {
    if (s.endsWith(ext.toLowerCase())) return true;
  }
  return false;
}

/**
 * Resolve a candidate to an absolute path per §3b rules. Returns null
 * when resolution would be ambiguous (relative path in a user-global
 * memory file with no repo root).
 */
export function resolveCandidate(
  s: string,
  file: MemoryFile,
  ctx: AuditContext,
  home: string,
): string | null {
  if (s.startsWith("~/")) return join(home, s.slice(2));
  if (isAbsolute(s)) return s;
  // Relative paths: resolve against repo root. For user-global files
  // there is no honest repo root → skip.
  if (file.displayPath.startsWith("~/")) return null;
  return resolve(ctx.repoRoot, s);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
