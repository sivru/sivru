// SIVRU-E260 deprecated-maturity-mismatch (DESIGN-0019 §10c). Two
// surfaces, one fact; keep them in sync.
//
// Direction A: JavaDoc/JSDoc/docstring has `@deprecated` AND block
//   maturity is not `deprecated`. SEVERITY: error — the JavaDoc is the
//   load-bearing signal that downstream tools (IDE warnings, deprecation
//   reports) read; a block that disagrees lies to the agent.
// Direction B: block maturity is `deprecated` AND the JavaDoc/JSDoc/
//   docstring lacks `@deprecated`. SEVERITY: warning — the block's
//   intent is right but the JavaDoc surface is missing.
// Both wrong (mixed signals): treat as direction A.

import type { BlockDiagnostic, SourceRange } from "./types.js";

const DEPRECATED_PATTERNS: Record<string, RegExp> = {
  java: /@deprecated\b/,
  javascript: /@deprecated\b/,
  typescript: /@deprecated\b/,
  tsx: /@deprecated\b/,
  jsx: /@deprecated\b/,
  // Python: `.. deprecated::` reST or `warnings.warn(DeprecationWarning)`.
  python: /(?:^|\s)\.\.\s+deprecated::|DeprecationWarning/,
  // Go: `// Deprecated:` line comment.
  go: /\/\/\s*Deprecated:/,
};

export type DeprecatedSyncInput = {
  docText: string;
  maturity: string | undefined;
  range: SourceRange;
  language: string;
};

/**
 * Compute the SIVRU-E260 diagnostic for a single block. Returns null
 * when the JavaDoc and block.maturity agree.
 */
export function checkDeprecatedMaturitySync(
  input: DeprecatedSyncInput,
): BlockDiagnostic | null {
  const pattern = DEPRECATED_PATTERNS[input.language];
  if (pattern === undefined) return null;
  const docDeprecated = pattern.test(input.docText);
  const blockDeprecated = input.maturity === "deprecated";

  if (docDeprecated && !blockDeprecated) {
    return {
      code: "SIVRU-E260",
      severity: "error",
      message: `deprecated-maturity-mismatch: doc comment carries @deprecated but block maturity is \`${input.maturity ?? "<none>"}\` — set maturity: deprecated or remove the doc tag`,
      location: input.range,
    };
  }
  if (!docDeprecated && blockDeprecated) {
    return {
      code: "SIVRU-E260",
      severity: "warning",
      message: `deprecated-maturity-mismatch: block maturity is \`deprecated\` but the doc comment lacks @deprecated — add @deprecated so IDE / downstream tools see the deprecation`,
      location: input.range,
    };
  }
  return null;
}
