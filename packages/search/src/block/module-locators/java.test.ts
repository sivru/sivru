import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractBlocks } from "../extract.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sivru-java-mod-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("Java package-info.java module locator (slot 4)", () => {
  it("extracts a module-level block from package-info.java", async () => {
    const file = join(tmpDir, "package-info.java");
    writeFileSync(
      file,
      `/**
 * @sivru
 * schema: 1
 * role: package-contract
 * responsibility: "every entity here is tenant-scoped"
 * @end
 */
package com.example.entities;
`,
    );
    const blocks = await extractBlocks(file);
    const module = blocks.find((b) => b.kind === "module");
    expect(module).toBeDefined();
    expect(module?.block?.role).toBe("package-contract");
  });

  it("does NOT emit a module block from a regular Java file", async () => {
    const file = join(tmpDir, "Foo.java");
    writeFileSync(
      file,
      `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: r
 * @end
 */
class Foo {}
`,
    );
    const blocks = await extractBlocks(file);
    const moduleBlocks = blocks.filter((b) => b.kind === "module");
    expect(moduleBlocks).toHaveLength(0);
  });
});

describe("Java records/enums carrier (slot 4)", () => {
  it("attaches a block to a record declaration", async () => {
    const file = join(tmpDir, "MemoryWriteScope.java");
    writeFileSync(
      file,
      `/**
 * @sivru
 * schema: 1
 * role: record
 * responsibility: "memory write scope"
 * @end
 */
public record MemoryWriteScope(String key, int value) {}
`,
    );
    const blocks = await extractBlocks(file);
    const symbolBlock = blocks.find((b) => b.kind === "symbol");
    expect(symbolBlock).toBeDefined();
    expect(symbolBlock?.symbolName).toBe("MemoryWriteScope");
  });

  it("attaches a block to an enum declaration", async () => {
    const file = join(tmpDir, "HookEvent.java");
    writeFileSync(
      file,
      `/**
 * @sivru
 * schema: 1
 * role: enum
 * responsibility: "hook events"
 * @end
 */
public enum HookEvent { CREATE, UPDATE, DELETE }
`,
    );
    const blocks = await extractBlocks(file);
    const symbolBlock = blocks.find((b) => b.kind === "symbol");
    expect(symbolBlock?.symbolName).toBe("HookEvent");
  });
});
