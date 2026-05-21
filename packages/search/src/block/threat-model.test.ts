// Threat-model tests (DESIGN-0016 F2 / acceptance criteria).
//
// js-yaml.load() with the default safe schema MUST NOT deserialize
// custom JS types — no method execution, no functions, no prototype
// pollution attacks. Loading is performed exclusively via `yaml.load`
// (never `loadAll` or `DEFAULT_FULL_SCHEMA`). This test loads a hostile
// fixture and asserts the parsed result is just a plain object.

import { describe, expect, it } from "vitest";

import { extractFences } from "./extract.js";

import yaml from "js-yaml";

const HOSTILE_YAML = `
!!js/function "function () { throw new Error('pwned') }"
`;

describe("js-yaml safe-load (F2)", () => {
  it("default load() rejects !!js/function (no method execution)", () => {
    expect(() => yaml.load(HOSTILE_YAML)).toThrow();
  });

  it("explicit JSON_SCHEMA also rejects !!js/function", () => {
    expect(() =>
      yaml.load(HOSTILE_YAML, { schema: yaml.JSON_SCHEMA }),
    ).toThrow();
  });

  it("the fence scanner doesn't crash on hostile body", () => {
    // The scanner doesn't execute YAML at all — it only tokenizes lines.
    // This guards against future regressions that try to do otherwise.
    const text = ["// @sivru", `// ${HOSTILE_YAML.trim()}`, "// @end"].join(
      "\n",
    );
    const out = extractFences(text, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.yamlText.includes("!!js/function")).toBe(true);
  });
});
