// Validate a parsed @sivru block (DESIGN-0016 §4).
//
// Diagnostics: severity `error` exits the CLI non-zero; `warning` prints
// to stderr but exits 0. Codes E215 (fence-unclosed) and E216 (yaml-
// malformed) fire inside `extract.ts` because the block can't be parsed
// at that point; everything else lives here.
//
// E219 is reserved for v0.6 implementation needs.

import { DEFAULT_BLOCK_CONFIG, resolveMaxLines, RUNAWAY_LINES } from "./config.js";
import { detectLanguage } from "../chunker/language.js";
import { closestMatch } from "./levenshtein.js";
import type {
  BlockDiagnostic,
  ExtractedBlock,
  SivruBlock,
  SivruBlockConfig,
  SourceRange,
} from "./types.js";

/**
 * Validate a SivruBlock against config (`requiredFields`,
 * `maturityValues`, `maxLines`, runaway ceiling). Returns the full
 * diagnostic list (empty when clean). Does not throw.
 *
 * @param block parsed block to check
 * @param ctx   per-block context: source range + optional config
 *
 * @sivru
 * schema: 1
 * role: block-validator
 * responsibility: produce the full BlockDiagnostic[] for one parsed block; never throws so the CLI can surface every issue
 * collaborators: [extractBlocks, loadBlockConfig]
 * invariants:
 *   - rule: "schema:1 is strict-rejected for any other value at v0.6 (SIVRU-E214)"
 *     enforced-by: packages/search/src/block/validate.test.ts::SIVRU-E214 fires on schema != 1
 *   - rule: "maturityValues is override-replaces-default; the user has to re-list defaults to extend them (DESIGN-0016 E4)"
 *     enforced-by: packages/search/src/block/validate.test.ts::SIVRU-E213 honors overridden maturityValues (replace, not extend)
 *   - rule: "the 100-line runaway ceiling (SIVRU-E212) is hardcoded; only the 25-line warning (SIVRU-E211) is configurable via maxLines"
 *     enforced-by: packages/search/src/block/validate.test.ts::SIVRU-E212 errors on block exceeding the hardcoded runaway ceiling
 * decisions:
 *   - chose: warning for SIVRU-E210 decision-no-revisit rather than error
 *     because: a decision without a revisit-if is a smell but not a build break; v0.7 drift detector will use the signal
 *     valid-while: decisions without revisit-if remain better than no decisions at all
 *     revisit-if: the v0.7 drift detector starts catching enough real drift that it becomes an error
 * maturity: stable
 * @end
 */
export function validateBlock(
  block: SivruBlock,
  ctx: {
    location: SourceRange;
    config?: SivruBlockConfig;
  },
): BlockDiagnostic[] {
  const cfg = ctx.config ?? DEFAULT_BLOCK_CONFIG;
  const out: BlockDiagnostic[] = [];

  // E214 schema-version-unsupported (strict-reject at v0.6).
  if (block.schema !== 1) {
    out.push({
      code: "SIVRU-E214",
      severity: "error",
      message: `schema-version-unsupported: schema ${block.schema} not supported at v0.6; expected 1`,
      location: ctx.location,
    });
  }

  // E217 missing-required.
  for (const field of cfg.requiredFields) {
    const v = (block as unknown as Record<string, unknown>)[field];
    if (typeof v !== "string" || v.length === 0) {
      out.push({
        code: "SIVRU-E217",
        severity: "error",
        message: `missing-required: \`${field}\` is required`,
        location: ctx.location,
      });
    }
  }

  // E213 maturity-invalid (only when maturity is present). Includes a
  // "did you mean" suggestion when the supplied value is within
  // Levenshtein distance 3 of a valid value (DESIGN-0019 §9c).
  if (block.maturity !== undefined) {
    if (!cfg.maturityValues.includes(block.maturity)) {
      const suggestion = closestMatch(block.maturity, cfg.maturityValues, 3);
      const hint =
        suggestion !== undefined ? ` (did you mean \`${suggestion}\`?)` : "";
      out.push({
        code: "SIVRU-E213",
        severity: "error",
        message: `maturity-invalid: \`${block.maturity}\` not in {${cfg.maturityValues.join(", ")}}${hint}`,
        location: ctx.location,
      });
    }
  }

  // E232 enforcement-unset (DESIGN-0019 §1): an object-form invariant
  // with explicit `enforced-by: null` is a tracked signal — the next
  // test to write. Default severity is warning; promote to error via
  // `enforcement.requireForObjectInvariants: true`.
  if (block.invariants !== undefined) {
    const requireEnforced =
      cfg.enforcement?.requireForObjectInvariants === true;
    for (const inv of block.invariants) {
      if (typeof inv === "object" && inv["enforced-by"] === null) {
        out.push({
          code: "SIVRU-E232",
          severity: requireEnforced ? "error" : "warning",
          message: `enforcement-unset: invariant "${inv.rule}" has \`enforced-by: null\` — no test enforces it yet`,
          location: ctx.location,
        });
      }
    }
  }

  // E210 decision-no-revisit (warning per decision missing revisit-if).
  if (block.decisions !== undefined) {
    for (const d of block.decisions) {
      const ri = d["revisit-if"];
      if (typeof ri !== "string" || ri.length === 0) {
        out.push({
          code: "SIVRU-E210",
          severity: "warning",
          message: `decision-no-revisit: decision "${d.chose}" has no \`revisit-if\``,
          location: ctx.location,
        });
      }
    }
  }

  // E211 block-prose (warning when block exceeds maxLines). Per-
  // language thresholds (DESIGN-0019 §8) consulted via resolveMaxLines.
  const spannedLines = ctx.location.endLine - ctx.location.startLine + 1;
  const language = detectLanguage(ctx.location.filePath) ?? undefined;
  const effectiveMaxLines = resolveMaxLines(cfg.maxLines, language);
  if (spannedLines > effectiveMaxLines) {
    out.push({
      code: "SIVRU-E211",
      severity: "warning",
      message: `block-prose: ${spannedLines} lines exceeds maxLines=${effectiveMaxLines}${
        language !== undefined ? ` (${language})` : ""
      }`,
      location: ctx.location,
    });
  }

  // E212 block-runaway is enforced in extract.ts already (before YAML
  // parse), but we also defend here in case validateBlock is called on
  // a hand-built block with no extraction step.
  if (spannedLines > RUNAWAY_LINES) {
    out.push({
      code: "SIVRU-E212",
      severity: "error",
      message: `block-runaway: ${spannedLines} lines exceeds hardcoded ceiling of ${RUNAWAY_LINES}`,
      location: ctx.location,
    });
  }

  return out;
}

/**
 * Validate every extracted block in a list, returning the diagnostics
 * already attached (from extract.ts) merged with the validateBlock()
 * output for each. Mutates each ExtractedBlock's `diagnostics` in place
 * AND returns the flattened list for convenience.
 */
export function validateExtracted(
  blocks: ExtractedBlock[],
  config?: SivruBlockConfig,
): BlockDiagnostic[] {
  const all: BlockDiagnostic[] = [];
  for (const eb of blocks) {
    if (eb.block !== null) {
      const more = validateBlock(eb.block, {
        location: eb.range,
        ...(config !== undefined ? { config } : {}),
      });
      eb.diagnostics.push(...more);
    }
    all.push(...eb.diagnostics);
  }
  return all;
}

/**
 * Convenience: true when any diagnostic in the list is error-severity.
 * Drives the CLI's exit code.
 */
export function hasErrors(diagnostics: readonly BlockDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
