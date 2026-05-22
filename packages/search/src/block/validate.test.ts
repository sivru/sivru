// Validation tests — one fixture per diagnostic in DESIGN-0016 §4.

import { describe, expect, it } from "vitest";

import { DEFAULT_BLOCK_CONFIG } from "./config.js";
import type { SivruBlock, SourceRange } from "./types.js";
import { hasErrors, validateBlock } from "./validate.js";

const loc: SourceRange = { filePath: "test.ts", startLine: 1, endLine: 10 };

function block(over: Partial<SivruBlock> = {}): SivruBlock {
  return {
    schema: 1,
    role: "r",
    responsibility: "p",
    ...over,
  };
}

describe("validateBlock — clean block", () => {
  it("emits no diagnostics on the minimal valid case", () => {
    const out = validateBlock(block(), { location: loc });
    expect(out).toEqual([]);
    expect(hasErrors(out)).toBe(false);
  });
});

describe("validateBlock — diagnostics", () => {
  it("SIVRU-E214 fires on schema != 1", () => {
    const out = validateBlock(block({ schema: 2 }), { location: loc });
    expect(out.map((d) => d.code)).toContain("SIVRU-E214");
    expect(hasErrors(out)).toBe(true);
  });

  it("SIVRU-E217 fires on missing role", () => {
    const out = validateBlock(block({ role: "" }), { location: loc });
    expect(out.map((d) => d.code)).toContain("SIVRU-E217");
  });

  it("SIVRU-E217 fires on missing responsibility", () => {
    const out = validateBlock(block({ responsibility: "" }), { location: loc });
    expect(out.map((d) => d.code)).toContain("SIVRU-E217");
  });

  it("SIVRU-E213 fires on a non-default maturity value", () => {
    const out = validateBlock(block({ maturity: "production" }), {
      location: loc,
    });
    expect(out.map((d) => d.code)).toContain("SIVRU-E213");
  });

  it("SIVRU-E213 honors overridden maturityValues (replace, not extend)", () => {
    const out = validateBlock(block({ maturity: "stable" }), {
      location: loc,
      config: {
        ...DEFAULT_BLOCK_CONFIG,
        maturityValues: ["gold", "silver"],
      },
    });
    expect(out.map((d) => d.code)).toContain("SIVRU-E213");
    const goldOk = validateBlock(block({ maturity: "gold" }), {
      location: loc,
      config: { ...DEFAULT_BLOCK_CONFIG, maturityValues: ["gold", "silver"] },
    });
    expect(goldOk).toEqual([]);
  });

  it("SIVRU-E210 fires per decision missing revisit-if", () => {
    const out = validateBlock(
      block({
        decisions: [
          { chose: "a", because: "b", "valid-while": "c" },
          {
            chose: "x",
            because: "y",
            "valid-while": "z",
            "revisit-if": "always",
          },
        ],
      }),
      { location: loc },
    );
    const e210 = out.filter((d) => d.code === "SIVRU-E210");
    expect(e210).toHaveLength(1);
    expect(e210[0]!.severity).toBe("warning");
  });

  it("SIVRU-E211 warns on block exceeding maxLines", () => {
    const out = validateBlock(block(), {
      location: { ...loc, endLine: 50 },
    });
    expect(out.map((d) => d.code)).toContain("SIVRU-E211");
    expect(hasErrors(out)).toBe(false);
  });

  it("SIVRU-E212 errors on block exceeding the hardcoded runaway ceiling", () => {
    const out = validateBlock(block(), {
      location: { ...loc, endLine: 250 },
    });
    const codes = out.map((d) => d.code);
    expect(codes).toContain("SIVRU-E212");
    expect(hasErrors(out)).toBe(true);
  });
});
