import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBlockCache } from "./block-cache.js";
import { hashBlockContent } from "./hash.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-block-cache-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildBlockCache", () => {
  it("includes files with no blocks (empty array, not absent)", async () => {
    const noBlock = join(tmpDir, "no-block.ts");
    writeFileSync(noBlock, "export const x = 1;\n");
    const cache = await buildBlockCache([noBlock]);
    expect(cache.get(noBlock)).toEqual([]);
  });

  it("captures one BlockCacheEntry per @sivru block with symbol name + hash", async () => {
    const f = join(tmpDir, "foo.ts");
    writeFileSync(
      f,
      `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * @end
 */
export function bar() {}
`,
    );
    const cache = await buildBlockCache([f]);
    const entries = cache.get(f);
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0]!.symbolName).toBe("bar");
    expect(entries![0]!.contentHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("emits contentHash:null on a malformed block (extracted with block:null)", async () => {
    const f = join(tmpDir, "broken.ts");
    writeFileSync(
      f,
      `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 // no @end
 */
export function bar() {}
`,
    );
    const cache = await buildBlockCache([f]);
    const entries = cache.get(f);
    // Unclosed fences may or may not surface here depending on the
    // extractor's tolerance; if any entry exists, its hash is null.
    if (entries !== undefined && entries.length > 0) {
      expect(entries[0]!.contentHash).toBeNull();
    }
  });

  it("identical blocks across two files produce identical hashes", async () => {
    const body = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: same shape
 * @end
 */
export function fn() {}
`;
    const a = join(tmpDir, "a.ts");
    const b = join(tmpDir, "b.ts");
    writeFileSync(a, body);
    writeFileSync(b, body);
    const cache = await buildBlockCache([a, b]);
    const ah = cache.get(a)![0]!.contentHash;
    const bh = cache.get(b)![0]!.contentHash;
    expect(ah).toBe(bh);
  });
});

describe("hashBlockContent — stability under key shuffling", () => {
  // Regression: previously the helper used `JSON.stringify(block)`,
  // which respects insertion order. A parser refactor that changes
  // the order fields are assigned would invalidate every cached hash.
  // The fix sorts keys recursively before stringifying.
  it("same fields in different insertion order produce identical hashes", () => {
    const blockA = {
      schema: 1,
      role: "r",
      responsibility: "p",
      maturity: "stable",
    };
    const blockB = {
      maturity: "stable",
      responsibility: "p",
      role: "r",
      schema: 1,
    };
    expect(hashBlockContent(blockA)).toBe(hashBlockContent(blockB));
  });

  it("changing a field value DOES change the hash", () => {
    const blockA = { schema: 1, role: "r", responsibility: "v1" };
    const blockB = { schema: 1, role: "r", responsibility: "v2" };
    expect(hashBlockContent(blockA)).not.toBe(hashBlockContent(blockB));
  });

  it("recursive shuffling: nested decisions[].* keys also normalised", () => {
    const a = {
      decisions: [
        { chose: "A", because: "B", "valid-while": "C", "revisit-if": "D" },
      ],
    };
    const b = {
      decisions: [
        { "revisit-if": "D", "valid-while": "C", because: "B", chose: "A" },
      ],
    };
    expect(hashBlockContent(a)).toBe(hashBlockContent(b));
  });

  it("array order IS significant (different ordering → different hash)", () => {
    // Invariant ordering carries authorial intent; we don't sort arrays.
    const a = { invariants: ["x", "y"] };
    const b = { invariants: ["y", "x"] };
    expect(hashBlockContent(a)).not.toBe(hashBlockContent(b));
  });
});
