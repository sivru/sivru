// Serialize a SivruBlock to its canonical JSON wire shape
// (DESIGN-0016 §5).
//
// The wire shape camelCases the YAML-native hyphenated field names
// (`valid-while` → `validWhile`; `revisit-if` → `revisitIf`) and
// null-fills missing optional decision.revisit-if so downstream
// consumers (v0.7 DESIGN-0017 surfacing via `sivru.explain`) get a
// fully populated, type-stable object — no `undefined` keys, no
// optional decision sub-fields.

import type { SivruBlock, SivruBlockJSON } from "./types.js";

/**
 * @sivru
 * schema: 1
 * role: block-serializer
 * responsibility: project a parsed SivruBlock onto its canonical JSON wire shape for downstream consumers
 * collaborators: [extractBlocks, assembleArtifact]
 * invariants:
 *   - hyphenated YAML field names (valid-while / revisit-if) become camelCase (validWhile / revisitIf) in JSON
 *   - missing optional fields become null or [] — no undefined keys in the output
 * decisions:
 *   - chose: camelCase JSON shape rather than mirror-the-YAML hyphenation
 *     because: JSON consumers (the explain artifact, MCP, downstream JS code) expect JS-idiomatic keys
 *     valid-while: JSON consumers in the ecosystem follow the camelCase convention
 *     revisit-if: a consumer needs the raw YAML-shape JSON for round-trip authoring
 * maturity: stable
 * @end
 */
export function blockToJSON(block: SivruBlock): SivruBlockJSON {
  return {
    schema: block.schema,
    role: block.role,
    responsibility: block.responsibility,
    maturity: block.maturity ?? null,
    collaborators: block.collaborators ?? [],
    // DESIGN-0019 §1: bare-string invariants project to the object form
    // with `enforcedBy: null`. Downstream consumers see a uniform shape.
    invariants: (block.invariants ?? []).map((inv) =>
      typeof inv === "string"
        ? { rule: inv, enforcedBy: null }
        : { rule: inv.rule, enforcedBy: inv["enforced-by"] },
    ),
    decisions: (block.decisions ?? []).map((d) => ({
      chose: d.chose,
      because: d.because,
      validWhile: d["valid-while"],
      revisitIf: d["revisit-if"] ?? null,
    })),
  };
}
