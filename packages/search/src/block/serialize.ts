// Serialize a SivruBlock back to its `@sivru … @end` YAML form (DESIGN-0019 §5).
//
// This is the inverse of extraction. The block scaffolder (`init.ts`) and the
// DESIGN-0021 slot-2 editor both go through this one helper so a round-trip
// (extract → edit → serialize) produces canonical, autofix-safe YAML.
//
// Returns ONLY the fence body — `@sivru\n<yaml>\n@end` — WITHOUT any host-
// language comment markers. Callers that write into a source file are
// responsible for re-applying the comment framing (`/** */`, `//`, `#`).

import yaml from "js-yaml";

import type { SivruBlock, SivruInvariant } from "./types.js";

/**
 * Serialize a parsed block to its canonical `@sivru … @end` body.
 *
 * Field order is fixed (schema, role, responsibility, collaborators,
 * invariants, decisions, maturity) so diffs stay stable across edits. Optional
 * sections are omitted when empty. `lineWidth: -1` disables line-folding so
 * long prose stays on one line and survives autofix's per-line rewriter.
 */
export function serializeBlock(block: SivruBlock): string {
  const body: Record<string, unknown> = {
    schema: block.schema,
    role: block.role,
    responsibility: block.responsibility,
  };
  if (block.collaborators !== undefined && block.collaborators.length > 0) {
    body["collaborators"] = block.collaborators;
  }
  if (block.invariants !== undefined && block.invariants.length > 0) {
    body["invariants"] = block.invariants.map((inv) => normalizeInvariant(inv));
  }
  if (block.decisions !== undefined && block.decisions.length > 0) {
    body["decisions"] = block.decisions.map((d) => {
      const o: Record<string, unknown> = {
        chose: d.chose,
        because: d.because,
        "valid-while": d["valid-while"],
      };
      if (d["revisit-if"] !== undefined) o["revisit-if"] = d["revisit-if"];
      return o;
    });
  }
  if (block.maturity !== undefined) {
    body["maturity"] = block.maturity;
  }
  const yamlBody = yaml.dump(body, { lineWidth: -1, noRefs: true, quotingType: '"' });
  return ["@sivru", yamlBody.trimEnd(), "@end"].join("\n");
}

/** Bare-string invariants become `{ rule, enforced-by: null }`; objects pass through. */
function normalizeInvariant(inv: string | SivruInvariant): { rule: string; "enforced-by": string | null } {
  if (typeof inv === "string") return { rule: inv, "enforced-by": null };
  return { rule: inv.rule, "enforced-by": inv["enforced-by"] };
}
