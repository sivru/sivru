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

export function blockToJSON(block: SivruBlock): SivruBlockJSON {
  return {
    schema: block.schema,
    role: block.role,
    responsibility: block.responsibility,
    maturity: block.maturity ?? null,
    collaborators: block.collaborators ?? [],
    invariants: block.invariants ?? [],
    decisions: (block.decisions ?? []).map((d) => ({
      chose: d.chose,
      because: d.because,
      validWhile: d["valid-while"],
      revisitIf: d["revisit-if"] ?? null,
    })),
  };
}
