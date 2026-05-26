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

  it("attaches a block to a NESTED enum inside an outer class", async () => {
    const file = join(tmpDir, "Outer.java");
    writeFileSync(
      file,
      `public class Outer {
  /**
   * @sivru
   * schema: 1
   * role: nested-enum
   * responsibility: "inner enum carries its own contract"
   * @end
   */
  enum Status { OPEN, CLOSED }
}
`,
    );
    const blocks = await extractBlocks(file);
    const symbolBlock = blocks.find(
      (b) => b.kind === "symbol" && b.symbolName === "Status",
    );
    expect(symbolBlock).toBeDefined();
    // The nested enum's block must NOT collapse into the outer class.
    const outerBlock = blocks.find(
      (b) => b.kind === "symbol" && b.symbolName === "Outer",
    );
    expect(outerBlock).toBeUndefined();
  });

  it("attaches a block to a sealed interface", async () => {
    const file = join(tmpDir, "Shape.java");
    writeFileSync(
      file,
      `/**
 * @sivru
 * schema: 1
 * role: sealed-interface
 * responsibility: "constrained type hierarchy"
 * @end
 */
public sealed interface Shape permits Circle, Square {}
`,
    );
    const blocks = await extractBlocks(file);
    const symbolBlock = blocks.find((b) => b.kind === "symbol");
    expect(symbolBlock?.symbolName).toBe("Shape");
  });

  it("attaches a block to an inner class", async () => {
    const file = join(tmpDir, "Container.java");
    writeFileSync(
      file,
      `public class Container {
  /**
   * @sivru
   * schema: 1
   * role: inner-class
   * responsibility: "private helper inside Container"
   * @end
   */
  static class Helper { int x; }
}
`,
    );
    const blocks = await extractBlocks(file);
    const symbolBlock = blocks.find(
      (b) => b.kind === "symbol" && b.symbolName === "Helper",
    );
    expect(symbolBlock).toBeDefined();
  });

  it("attaches a block to an annotation type declaration", async () => {
    const file = join(tmpDir, "MyAnnotation.java");
    writeFileSync(
      file,
      `/**
 * @sivru
 * schema: 1
 * role: annotation
 * responsibility: "marker annotation"
 * @end
 */
public @interface MyAnnotation {}
`,
    );
    const blocks = await extractBlocks(file);
    const symbolBlock = blocks.find((b) => b.kind === "symbol");
    expect(symbolBlock?.symbolName).toBe("MyAnnotation");
  });
});
