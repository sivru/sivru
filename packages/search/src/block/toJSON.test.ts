// blockToJSON round-trip + canonical-shape tests (DESIGN-0016 §5).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractBlocks } from "./extract.js";
import { blockToJSON } from "./toJSON.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string): string =>
  resolve(here, "__fixtures__", rel);

describe("blockToJSON — canonical shape", () => {
  it("camelCases hyphenated decision fields and null-fills missing revisit-if", () => {
    const out = blockToJSON({
      schema: 1,
      role: "r",
      responsibility: "p",
      decisions: [
        { chose: "a", because: "b", "valid-while": "c" },
        {
          chose: "x",
          because: "y",
          "valid-while": "z",
          "revisit-if": "always",
        },
      ],
    });
    expect(out.decisions[0]).toEqual({
      chose: "a",
      because: "b",
      validWhile: "c",
      revisitIf: null,
    });
    expect(out.decisions[1]).toEqual({
      chose: "x",
      because: "y",
      validWhile: "z",
      revisitIf: "always",
    });
  });

  it("null-fills missing maturity and empty-fills arrays", () => {
    const out = blockToJSON({ schema: 1, role: "r", responsibility: "p" });
    expect(out.maturity).toBeNull();
    expect(out.collaborators).toEqual([]);
    expect(out.invariants).toEqual([]);
    expect(out.decisions).toEqual([]);
  });

  it("DESIGN-0019 §1: bare-string invariants project to object form with enforcedBy=null", () => {
    const out = blockToJSON({
      schema: 1,
      role: "r",
      responsibility: "p",
      invariants: ["bare string invariant"],
    });
    expect(out.invariants[0]).toEqual({
      rule: "bare string invariant",
      enforcedBy: null,
    });
  });

  it("DESIGN-0019 §1: object-form invariants camelCase enforced-by → enforcedBy", () => {
    const out = blockToJSON({
      schema: 1,
      role: "r",
      responsibility: "p",
      invariants: [
        { rule: "non-leader nodes return early", "enforced-by": null },
        {
          rule: "tenant context cleared",
          "enforced-by": "TenantContextLeakTest.testClears",
        },
      ],
    });
    expect(out.invariants).toEqual([
      { rule: "non-leader nodes return early", enforcedBy: null },
      {
        rule: "tenant context cleared",
        enforcedBy: "TenantContextLeakTest.testClears",
      },
    ]);
  });

  it("DESIGN-0019 §1: mixed forms preserve order", () => {
    const out = blockToJSON({
      schema: 1,
      role: "r",
      responsibility: "p",
      invariants: [
        "bare1",
        { rule: "object1", "enforced-by": "X.y" },
        "bare2",
      ],
    });
    expect(out.invariants.map((i) => i.rule)).toEqual(["bare1", "object1", "bare2"]);
    expect(out.invariants[0]?.enforcedBy).toBeNull();
    expect(out.invariants[1]?.enforcedBy).toBe("X.y");
    expect(out.invariants[2]?.enforcedBy).toBeNull();
  });
});

describe("blockToJSON — round-trip parity across carriers", () => {
  it("TS, JS, Java, Go, Python all yield the same canonical JSON for identical body", async () => {
    const files = [
      "per-language/ts/symbol-block.ts",
      "per-language/js/symbol-block.js",
      "per-language/java/SymbolBlock.java",
      "per-language/go/symbol_block.go",
      "per-language/python/symbol_block.py",
    ];
    const jsons = await Promise.all(
      files.map(async (f) => {
        const out = await extractBlocks(fixture(f));
        expect(out).toHaveLength(1);
        const b = out[0]!.block;
        expect(b).not.toBeNull();
        return blockToJSON(b!);
      }),
    );
    // All should have the same canonical content.
    for (let i = 1; i < jsons.length; i++) {
      expect(jsons[i]).toEqual(jsons[0]);
    }
    expect(jsons[0]!.role).toBe("routing-brain");
    expect(jsons[0]!.decisions[0]?.validWhile).toMatch(/channel-specific/);
  });
});
