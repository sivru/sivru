// Autofix rewriter for SIVRU-E237 yaml-colon-in-prose and SIVRU-E238
// yaml-quote-context (DESIGN-0019 §9). The autofix is opt-in via the
// `--autofix` CLI flag — never default.
//
// Safety rules (per design §Open questions):
//   - Refuse to autofix if the value already contains `"` characters
//     that would require escape rewriting (those need human review).
//   - Preserve trailing whitespace and indentation exactly.
//   - Refuse to autofix files with uncommitted changes unless --force
//     is passed (the CLI layer enforces this; the rewriter takes a
//     pre-checked file list).
//   - Idempotent: re-running on a clean file is a no-op.
//
// Strategy:
//   1. Run `extractBlocks` on each candidate file.
//   2. For every block carrying an E237 / E238 diagnostic, parse the
//      diagnostic's location into the line range, then walk lines and
//      apply per-line rewrites.
//   3. Write the rewritten content back only when at least one rewrite
//      landed.

import { readFile, writeFile } from "node:fs/promises";

import { extractBlocks } from "./extract.js";
import { _internal as yamlInternal } from "./yaml-errors.js";
import type { BlockDiagnostic } from "./types.js";

export type AutofixResult = {
  filePath: string;
  rewrites: number;
  /** Diagnostics that remain after the rewrite — e.g., values that couldn't be safely quoted. */
  remaining: BlockDiagnostic[];
  /** Diagnostics that were rewritten away. */
  fixed: BlockDiagnostic[];
};

const { unbalancedApostrophes, unquotedColonColumnInValue } = yamlInternal;

/**
 * Decide whether `line` is rewriteable to a safe form. Returns the
 * rewritten line + a flag, or `{ rewrote: false }` when we should leave
 * it alone (e.g., embedded double-quotes that would need escaping).
 */
function rewriteLine(
  line: string,
  diagnosticCode: string,
): { rewrote: boolean; line: string; reason?: string } {
  // Some source files carry the YAML inside doc comments — strip the
  // comment-syntax prefix (`*` / `//` / `#`) once before running the
  // value match, then reapply the prefix to the rewritten line.
  const commentMatch = line.match(/^(\s*(?:\*|\/\/|#|\/\/\/)\s?)(.*)$/);
  const commentPrefix = commentMatch !== null ? commentMatch[1]! : "";
  const yamlPortion = commentMatch !== null ? commentMatch[2]! : line;

  const dashMatch = yamlPortion.match(/^(\s*-\s+)(.*)$/);
  const fieldMatch = yamlPortion.match(/^(\s*(?:chose|because|valid-while|revisit-if|rule|enforced-by|responsibility|role):\s+)(.*)$/);

  let prefix = "";
  let value = "";
  let trailing = "";
  if (dashMatch !== null) {
    prefix = dashMatch[1]!;
    value = dashMatch[2]!;
  } else if (fieldMatch !== null) {
    prefix = fieldMatch[1]!;
    value = fieldMatch[2]!;
  } else {
    return { rewrote: false, line, reason: "not a recognised array-item or field line" };
  }

  // Preserve trailing whitespace exactly per safety rules.
  const valueTrimEnd = value.replace(/\s+$/, "");
  trailing = value.slice(valueTrimEnd.length);
  value = valueTrimEnd;

  // Already double-quoted? No-op.
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return { rewrote: false, line, reason: "already double-quoted" };
  }

  // E238 single-quote rewrite: the value contains apostrophes that
  // js-yaml treated as a single-quoted string. Strip the leading/
  // trailing pair (if any) and wrap the whole thing in double-quotes.
  if (diagnosticCode === "SIVRU-E238") {
    if (value.includes('"')) {
      return { rewrote: false, line, reason: "value contains `\"` — needs human review" };
    }
    return { rewrote: true, line: `${commentPrefix}${prefix}"${value}"${trailing}` };
  }

  // E237 colon-in-prose rewrite: wrap the whole value in double-quotes.
  if (value.includes('"')) {
    return { rewrote: false, line, reason: "value contains `\"` — needs human review" };
  }
  return { rewrote: true, line: `${commentPrefix}${prefix}"${value}"${trailing}` };
}

/**
 * Re-extract a file, identify E237/E238 diagnostics, rewrite the
 * offending lines, and write the file back. Returns a per-file result.
 *
 * @sivru
 * schema: 1
 * role: block-autofix
 * responsibility: rewrite SIVRU-E237/E238 lines in place to safe double-quoted YAML; idempotent and opt-in
 * collaborators: [extractBlocks, wrapYamlError]
 * invariants:
 *   - rule: refuse to autofix values containing `"` — those need human review
 *     enforced-by: refusesToAutofixEmbeddedDoubleQuote
 *   - rule: re-running on a clean file is a no-op (idempotent)
 *     enforced-by: idempotentOnCleanFile
 *   - rule: preserve indentation and trailing whitespace exactly
 *     enforced-by: null
 * decisions:
 *   - chose: line-level rewrite instead of re-emitting the whole YAML
 *     because: source files contain YAML inside doc-comments; re-emitting the YAML would lose comments, whitespace, and ordering
 *     valid-while: the autofix targets known one-line patterns (colon-in-prose, apostrophe-imbalance)
 *     revisit-if: a new YAML failure mode requires structural multi-line rewriting
 * maturity: experimental
 * @end
 */
export async function autofixFile(filePath: string): Promise<AutofixResult> {
  const content = await readFile(filePath, "utf8");
  const blocks = await extractBlocks(filePath, { content });
  const fixed: BlockDiagnostic[] = [];
  const remaining: BlockDiagnostic[] = [];
  const lines = content.split("\n");

  let rewrites = 0;
  for (const eb of blocks) {
    for (const d of eb.diagnostics) {
      if (d.code !== "SIVRU-E237" && d.code !== "SIVRU-E238") {
        continue;
      }
      const loc = d.location;
      if (loc === undefined) {
        remaining.push(d);
        continue;
      }
      // Walk the lines inside the block range; rewrite each line that
      // triggers the same heuristic as the diagnostic. Source lines may
      // carry a comment prefix (`*` / `//` / `#`); strip it before
      // running the heuristic so the trap is found in the YAML half.
      let rewroteAny = false;
      const stripComment = (l: string): string =>
        l.replace(/^\s*(?:\*|\/\/|#|\/\/\/)\s?/, "");
      // E237 trap signature: an array-item line whose value contains
      // a colon, OR a field-line value with an internal colon. Both
      // collapse to "the value of this line contains a `:` and was
      // parsed as a map by YAML".
      const E237_PATTERN = /^\s*(?:-\s+\S.*:\s+\S|\w+:\s+\S.*:\s+\S)/;
      for (let i = loc.startLine; i <= loc.endLine; i++) {
        const idx = i - 1;
        if (idx < 0 || idx >= lines.length) continue;
        const line = lines[idx]!;
        const yamlPart = stripComment(line);
        const triggersE237 =
          d.code === "SIVRU-E237" && E237_PATTERN.test(yamlPart);
        const triggersE238 =
          d.code === "SIVRU-E238" && unbalancedApostrophes(yamlPart);
        if (!triggersE237 && !triggersE238) continue;
        const rewritten = rewriteLine(line, d.code);
        if (rewritten.rewrote) {
          lines[idx] = rewritten.line;
          rewrites += 1;
          rewroteAny = true;
        }
      }
      if (rewroteAny) fixed.push(d);
      else remaining.push(d);
    }
  }

  if (rewrites > 0) {
    await writeFile(filePath, lines.join("\n"));
  }
  return { filePath, rewrites, fixed, remaining };
}

/**
 * Batch autofix across many files. Returns the per-file results; the
 * CLI surfaces a summary line per file.
 */
export async function autofixFiles(
  filePaths: readonly string[],
): Promise<AutofixResult[]> {
  const out: AutofixResult[] = [];
  for (const p of filePaths) {
    try {
      out.push(await autofixFile(p));
    } catch (err) {
      out.push({
        filePath: p,
        rewrites: 0,
        fixed: [],
        remaining: [
          {
            code: "SIVRU-E216",
            severity: "error",
            message: `autofix: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      });
    }
  }
  return out;
}
