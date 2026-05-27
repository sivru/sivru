import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractBlocksFromFiles } from "./extract.js";
import { checkBridges } from "./check-bridges.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-bridges-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function writeJavaFixture(name: string, content: string): string {
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  const p = join(tmpDir, "src", name);
  writeFileSync(p, content);
  return p;
}

describe("checkBridges — Java (DESIGN-0019 §10b)", () => {
  it("emits SIVRU-E239 when @ApplicationScoped is missing its canonical invariant", async () => {
    const p = writeJavaFixture(
      "FooService.java",
      `/**
 * @sivru
 * schema: 1
 * role: service
 * responsibility: "do the thing"
 * @end
 */
@ApplicationScoped
public class FooService {}
`,
    );
    const blocks = await extractBlocksFromFiles([p]);
    const diagnostics = await checkBridges(blocks, tmpDir);
    expect(diagnostics.map((d) => d.code)).toContain("SIVRU-E239");
    const e239 = diagnostics.find((d) => d.code === "SIVRU-E239");
    expect(e239?.message).toContain("@ApplicationScoped");
    expect(e239?.message).toContain("thread-safe; no instance state");
  });

  it("clears when the canonical invariant is present in the block", async () => {
    const p = writeJavaFixture(
      "FooService.java",
      `/**
 * @sivru
 * schema: 1
 * role: service
 * responsibility: "do the thing"
 * invariants:
 *   - "thread-safe; no instance state per @ApplicationScoped"
 * @end
 */
@ApplicationScoped
public class FooService {}
`,
    );
    const blocks = await extractBlocksFromFiles([p]);
    const diagnostics = await checkBridges(blocks, tmpDir);
    expect(diagnostics.filter((d) => d.code === "SIVRU-E239")).toHaveLength(0);
  });

  it("emits SIVRU-E260 when JavaDoc carries @deprecated but block.maturity disagrees", async () => {
    const p = writeJavaFixture(
      "Old.java",
      `/**
 * @deprecated use NewThing
 *
 * @sivru
 * schema: 1
 * role: r
 * responsibility: "old"
 * maturity: stable
 * @end
 */
public class Old {}
`,
    );
    const blocks = await extractBlocksFromFiles([p]);
    const diagnostics = await checkBridges(blocks, tmpDir);
    const e260 = diagnostics.find((d) => d.code === "SIVRU-E260");
    expect(e260).toBeDefined();
    expect(e260?.severity).toBe("error");
  });
});

describe("checkBridges — SIVRU-E260 across TS/JS/Go (DESIGN-0019 §10c)", () => {
  function writeFixture(name: string, content: string): string {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const p = join(tmpDir, "src", name);
    writeFileSync(p, content);
    return p;
  }

  it("TypeScript: JSDoc @deprecated + stable maturity → error", async () => {
    const p = writeFixture(
      "Old.ts",
      `/**
 * @deprecated use NewService
 *
 * @sivru
 * schema: 1
 * role: r
 * responsibility: "old"
 * maturity: stable
 * @end
 */
export class Old {}
`,
    );
    const blocks = await extractBlocksFromFiles([p]);
    const diagnostics = await checkBridges(blocks, tmpDir);
    const e260 = diagnostics.find((d) => d.code === "SIVRU-E260");
    expect(e260).toBeDefined();
    expect(e260?.severity).toBe("error");
  });

  it("Go: // Deprecated: comment + stable maturity → error", async () => {
    const p = writeFixture(
      "old.go",
      `package main

// Deprecated: use NewFoo
//
// @sivru
// schema: 1
// role: r
// responsibility: "old"
// maturity: stable
// @end
func Old() {}
`,
    );
    const blocks = await extractBlocksFromFiles([p]);
    const diagnostics = await checkBridges(blocks, tmpDir);
    const e260 = diagnostics.find((d) => d.code === "SIVRU-E260");
    expect(e260).toBeDefined();
    expect(e260?.severity).toBe("error");
  });

  it("TS: direction B — block deprecated + silent doc → warning", async () => {
    const p = writeFixture(
      "Faded.ts",
      `/**
 * Some thing.
 *
 * @sivru
 * schema: 1
 * role: r
 * responsibility: "old"
 * maturity: deprecated
 * @end
 */
export class Faded {}
`,
    );
    const blocks = await extractBlocksFromFiles([p]);
    const diagnostics = await checkBridges(blocks, tmpDir);
    const e260 = diagnostics.find((d) => d.code === "SIVRU-E260");
    expect(e260).toBeDefined();
    expect(e260?.severity).toBe("warning");
  });
});
