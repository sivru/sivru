// In-place `@sivru … @end` fence rewriting (DESIGN-0021 §"The block editor").
//
// `ExtractedBlock.range` is line-based: startLine is the `@sivru` line, endLine
// the `@end` line (verified: extract.ts builds range from fence.startLine/
// endLine). The host-language comment delimiters (`/**`, `*/`) sit on lines
// OUTSIDE that range, so a rewrite only ever replaces lines [startLine, endLine].
//
// We never reconstruct comment syntax from scratch — we detect the existing
// per-line prefix (whitespace + comment marker) from the `@sivru` line and
// re-apply it to each line of the new fence body. That makes the rewrite
// comment-style-agnostic: JSDoc (` * `), line comments (`// ` / `/// `), and
// Python docstrings (indentation only) all round-trip. The new YAML may be
// longer or shorter than the old — we splice N lines for M.

export interface FenceRange {
  startLine: number; // 1-indexed, the @sivru line
  endLine: number; // 1-indexed, the @end line
}

export type FenceRewrite =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * Replace the fence at `range` in `content` with `newFenceBody`
 * (`@sivru\n<yaml>\n@end`, no comment markers — from `serializeBlock`).
 * Returns the full new file content, preserving everything outside the fence.
 */
export function rewriteFence(content: string, range: FenceRange, newFenceBody: string): FenceRewrite {
  const lines = content.split("\n");
  if (range.startLine < 1 || range.endLine > lines.length || range.startLine > range.endLine) {
    return { ok: false, reason: "fence range is out of bounds for the current file" };
  }
  const startIdx = range.startLine - 1;
  const endIdx = range.endLine - 1;

  const firstLine = lines[startIdx]!;
  const at = firstLine.indexOf("@sivru");
  if (at < 0) {
    // The recorded line no longer holds @sivru — the file moved under us.
    return { ok: false, reason: "no @sivru at the recorded fence start line" };
  }
  // Everything before @sivru is the per-line prefix (indent + comment marker).
  const prefix = firstLine.slice(0, at);

  const reframed = newFenceBody.split("\n").map((bodyLine) =>
    // Avoid trailing whitespace on blank body lines (e.g. " *" not " * ").
    bodyLine.length === 0 ? prefix.replace(/[ \t]+$/, "") : prefix + bodyLine,
  );

  const next = [...lines.slice(0, startIdx), ...reframed, ...lines.slice(endIdx + 1)];
  return { ok: true, content: next.join("\n") };
}

/** The detected per-line comment prefix for the fence at `range`, or null. */
export function detectFencePrefix(content: string, range: FenceRange): string | null {
  const lines = content.split("\n");
  const line = lines[range.startLine - 1];
  if (line === undefined) return null;
  const at = line.indexOf("@sivru");
  return at < 0 ? null : line.slice(0, at);
}
