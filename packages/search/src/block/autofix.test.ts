import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autofixFile } from "./autofix.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-autofix-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(file: string, content: string): string {
  const p = join(tmpDir, file);
  writeFileSync(p, content);
  return p;
}

describe("autofixFile", () => {
  it("rewrites a colon-in-prose invariant to double-quoted form", async () => {
    const src = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * invariants:
 *   - tx: REQUIRES_NEW per-row failure does not abort the run
 * @end
 */
export function foo() {}
`;
    const path = writeFixture("foo.ts", src);
    const result = await autofixFile(path);
    expect(result.rewrites).toBe(1);
    const after = readFileSync(path, "utf8");
    expect(after).toContain('"tx: REQUIRES_NEW per-row failure does not abort the run"');
  });

  it("refuses to rewrite values containing embedded double-quotes", async () => {
    const src = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * invariants:
 *   - tx: prefer "REQUIRES_NEW" here
 * @end
 */
export function foo() {}
`;
    const path = writeFixture("foo.ts", src);
    const result = await autofixFile(path);
    // The value contains embedded `"`, so the rewriter refuses.
    expect(result.rewrites).toBe(0);
  });

  it("is idempotent on a clean file", async () => {
    const src = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: "responsibility"
 * invariants:
 *   - "tx: REQUIRES_NEW per-row failure does not abort the run"
 * @end
 */
export function foo() {}
`;
    const path = writeFixture("foo.ts", src);
    const first = await autofixFile(path);
    expect(first.rewrites).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toBe(src);
    const second = await autofixFile(path);
    expect(second.rewrites).toBe(0);
  });
});
