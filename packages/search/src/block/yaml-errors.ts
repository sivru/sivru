// Wrap js-yaml parse errors into more actionable BlockDiagnostics
// (DESIGN-0019 §9). The bare js-yaml message is preserved underneath
// the wrapped diagnostic so debugging never loses context.
//
// Three families:
//   - SIVRU-E237 yaml-colon-in-prose: unquoted `:` in a value that
//     should be a string scalar. The Java idiom `tx: REQUIRES_NEW`
//     written as `- tx: REQUIRES_NEW per-row …` collides with YAML's
//     mapping syntax.
//   - SIVRU-E238 yaml-quote-context: apostrophes around an identifier-
//     like token (`'this.commit()'`) parse as a single-quoted string;
//     a trailing comma then triggers an opaque "mapping entry not
//     allowed here". The wrapper points at the apostrophes.
//   - SIVRU-E216 yaml-malformed: every other parse error keeps the
//     original v0.6 behavior (no message change).
//
// The diagnostic carries `data` with the original line text + 1-indexed
// column so `autofix.ts` can rewrite the offending line without
// re-parsing the YAML.

import type { BlockDiagnostic, SourceRange } from "./types.js";

/**
 * YAML mark from js-yaml's parse error. The 0-indexed `line` / `column`
 * are relative to the parsed body (NOT the source file), so callers
 * who want a file-relative line add them to `range.startLine + 1`
 * (the first body line lives at startLine + 1).
 */
type YamlMark = {
  line: number;
  column: number;
  buffer?: string;
};

type YamlExceptionLike = {
  message: string;
  mark?: YamlMark;
  reason?: string;
};

function isYamlException(err: unknown): err is YamlExceptionLike {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

/**
 * Find the line text where the YAML parser failed. Returns "" if the
 * mark is missing or out of bounds (still safe — diagnostic message
 * just omits the source snippet).
 */
function lineAtMark(yamlText: string, mark: YamlMark | undefined): string {
  if (mark === undefined) return "";
  const lines = yamlText.split("\n");
  return lines[mark.line] ?? "";
}

/**
 * Crude apostrophe-balance check: count single quotes outside any
 * `"..."` region of the line. Odd count → unterminated single-quote
 * suspect. This is the §9b heuristic.
 */
function unbalancedApostrophes(line: string): boolean {
  let inDouble = false;
  let apostrophes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && ch === "'") apostrophes += 1;
  }
  return apostrophes % 2 === 1;
}

/**
 * Find the column of an unquoted colon inside the "value" half of a
 * YAML line. Returns -1 if no candidate found. We look only AFTER the
 * first `: ` (the mapping-key separator) — colons inside the key half
 * are real YAML structure, not the §9a trap.
 */
function unquotedColonColumnInValue(line: string): number {
  // For "- foo: bar: baz", the structural `:` is the first one. Find
  // the value half after the first ": ".
  const valueStart = line.search(/: \S/);
  if (valueStart === -1) {
    // Array-item form: `  - tx: REQUIRES_NEW …` — the `- ` makes
    // the rest a scalar by default, and a colon further in is the
    // ambiguity. Detect it directly.
    const dashIdx = line.search(/^\s*-\s+/);
    if (dashIdx === -1) return -1;
    const afterDash = line.replace(/^\s*-\s+/, "");
    const colonInValue = afterDash.indexOf(":");
    if (colonInValue === -1) return -1;
    // Skip if the dashed value is already double-quoted.
    if (afterDash.trim().startsWith('"')) return -1;
    return line.length - afterDash.length + colonInValue;
  }
  // After "key: ", look for another colon followed by a space or EOL.
  const afterKey = line.slice(valueStart + 2);
  // Skip if already quoted.
  if (afterKey.trim().startsWith('"') || afterKey.trim().startsWith("'")) {
    return -1;
  }
  const m = afterKey.match(/[^"]*?(:)(?:\s|$)/);
  if (m === null || m.index === undefined) return -1;
  // Reconstruct file column.
  return valueStart + 2 + m.index + m[0].indexOf(":");
}

/**
 * Build a one-line "caret" snippet pointing at `col` (0-indexed) under
 * the offending `line`. Used in the diagnostic message body.
 */
function snippet(line: string, col: number): string {
  const trimmedCol = col < 0 ? 0 : col;
  const padding = " ".repeat(trimmedCol);
  return `\n  ${line}\n  ${padding}^`;
}

/**
 * Wrap a js-yaml exception into the best matching BlockDiagnostic.
 * Always returns a single diagnostic — falls back to SIVRU-E216 for
 * shapes we don't recognise so the v0.6 behavior is preserved.
 *
 * Exported so callers (notably the autofix rewriter) can detect E237
 * / E238 and locate the column to rewrite.
 */
export function wrapYamlError(
  err: unknown,
  yamlText: string,
  range: SourceRange,
): BlockDiagnostic {
  const message = isYamlException(err) ? err.message : String(err);
  const mark = isYamlException(err) ? err.mark : undefined;
  const failingLine = lineAtMark(yamlText, mark);

  // §9b: apostrophe-balance check fires first because the original
  // js-yaml error is the most cryptic ("mapping entry not allowed here").
  if (failingLine !== "" && unbalancedApostrophes(failingLine)) {
    const apostropheCol = failingLine.indexOf("'");
    return {
      code: "SIVRU-E238",
      severity: "error",
      message:
        `yaml-quote-context: apostrophes in this line look like a YAML ` +
        `single-quoted string but the surrounding context expects a ` +
        `bare string. Wrap the whole value in double quotes, or escape ` +
        `the apostrophes (''). Run \`sivru block validate --autofix\` ` +
        `to apply the double-quote rewrite.${snippet(failingLine, apostropheCol)}\n  ` +
        `(original yaml error: ${message})`,
      location: range,
    };
  }

  // §9a: colon-in-prose check.
  if (failingLine !== "") {
    const colonCol = unquotedColonColumnInValue(failingLine);
    if (colonCol !== -1) {
      return {
        code: "SIVRU-E237",
        severity: "error",
        message:
          `yaml-colon-in-prose: unquoted \`:\` inside a prose value. ` +
          `Wrap the value in double quotes, or run ` +
          `\`sivru block validate --autofix\` to apply the rewrite.` +
          `${snippet(failingLine, colonCol)}\n  ` +
          `(original yaml error: ${message})`,
        location: range,
      };
    }
  }

  return {
    code: "SIVRU-E216",
    severity: "error",
    message: `yaml-malformed: ${message}`,
    location: range,
  };
}

/**
 * Re-export the heuristics so the autofix module can replay them on a
 * line and decide whether to rewrite. Keeping these private to this
 * file would force the autofix to re-parse js-yaml and re-detect.
 */
export const _internal = {
  unbalancedApostrophes,
  unquotedColonColumnInValue,
};
