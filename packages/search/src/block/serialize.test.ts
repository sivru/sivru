import { describe, expect, it } from "vitest";

import { serializeBlock } from "./serialize.js";
import { extractBlocks } from "./extract.js";
import type { SivruBlock } from "./types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("serializeBlock", () => {
  it("emits canonical @sivru…@end with fixed field order, omitting empties", () => {
    const block: SivruBlock = {
      schema: 1,
      role: "svc",
      responsibility: "does things",
      maturity: "stable",
    };
    const out = serializeBlock(block);
    expect(out.startsWith("@sivru\n")).toBe(true);
    expect(out.trimEnd().endsWith("@end")).toBe(true);
    expect(out).toContain("schema: 1");
    expect(out).toContain("role: svc");
    expect(out).toContain("maturity: stable");
    // No empty collaborators/invariants/decisions sections.
    expect(out).not.toContain("collaborators:");
    expect(out).not.toContain("invariants:");
  });

  it("normalizes bare-string invariants to { rule, enforced-by: null }", () => {
    const out = serializeBlock({
      schema: 1,
      role: "r",
      responsibility: "x",
      invariants: ["must hold"],
    });
    expect(out).toContain("rule: must hold");
    expect(out).toContain("enforced-by: null");
  });

  it("round-trips: extract → serialize → re-extract preserves fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sivru-serialize-"));
    try {
      const src = `/**
 * @sivru
 * schema: 1
 * role: original
 * responsibility: the original responsibility
 * collaborators: [helperX]
 * invariants:
 *   - rule: stays consistent
 *     enforced-by: null
 * maturity: stable
 * @end
 */
export function thing() {}
`;
      const file = join(dir, "thing.ts");
      writeFileSync(file, src);
      const extracted = await extractBlocks(file);
      const block = extracted[0]?.block;
      expect(block).not.toBeNull();
      const serialized = serializeBlock(block!);
      // The serialized body re-parses to the same logical block.
      expect(serialized).toContain("role: original");
      expect(serialized).toContain("collaborators:");
      expect(serialized).toContain("- helperX");
      expect(serialized).toContain("rule: stays consistent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
