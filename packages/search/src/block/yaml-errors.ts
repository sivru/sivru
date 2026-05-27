// Wrap js-yaml parse errors into more actionable BlockDiagnostics
// (DESIGN-0019 §9). The bare js-yaml message is preserved underneath
// the wrapped diagnostic so debugging never loses context.
//
// Two families:
//   - SIVRU-E238 yaml-quote-context: apostrophes around an identifier-
//     like token (`'this.commit()'`) parse as a single-quoted string;
//     a trailing comma then triggers an opaque "mapping entry not
//     allowed here". The wrapper points at the apostrophes.
//   - SIVRU-E216 yaml-malformed: every other parse error keeps the
//     original v0.6 behavior (no message change).
//
// SIVRU-E237 yaml-colon-in-prose is NOT detected here — when YAML
// fails on a structural issue we'd usually see E238 or E216. The
// colon-in-prose case is a SILENT drift (YAML succeeds, but parses
// the prose as a nested mapping); `extract.ts:parseFenceBody` catches
// that case post-parse by inspecting the shape of the parsed
// invariants array.

import { unbalancedApostrophes } from "./yaml-heuristics.js";
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

  return {
    code: "SIVRU-E216",
    severity: "error",
    message: `yaml-malformed: ${message}`,
    location: range,
  };
}
