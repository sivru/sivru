// Python module-locator tests — PEP 257 strict (DESIGN-0016 §3, A2).

import { describe, expect, it } from "vitest";

import { extractBlocks } from "../extract.js";

async function run(content: string): Promise<{
  hasModuleBlock: boolean;
}> {
  const out = await extractBlocks("/tmp/test-locator.py", {
    content,
    language: "python",
  });
  return { hasModuleBlock: out.some((b) => b.kind === "module") };
}

describe("pythonModuleLocator — PEP 257 strict", () => {
  it("recognizes a top-of-file docstring as a module-level carrier", async () => {
    const content = [
      '"""',
      "@sivru",
      "schema: 1",
      "role: r",
      "responsibility: p",
      "@end",
      '"""',
      "def foo(): pass",
    ].join("\n");
    expect((await run(content)).hasModuleBlock).toBe(true);
  });

  it("recognizes a docstring after `from __future__` imports", async () => {
    const content = [
      "from __future__ import annotations",
      "",
      '"""',
      "@sivru",
      "schema: 1",
      "role: r",
      "responsibility: p",
      "@end",
      '"""',
      "def foo(): pass",
    ].join("\n");
    expect((await run(content)).hasModuleBlock).toBe(true);
  });

  it("does NOT recognize an f-string as a docstring (matches CPython)", async () => {
    const content = [
      'f"""',
      "@sivru",
      "schema: 1",
      "role: r",
      "responsibility: p",
      "@end",
      '"""',
      "def foo(): pass",
    ].join("\n");
    expect((await run(content)).hasModuleBlock).toBe(false);
  });

  it("does not invent a module block when the file has no docstring", async () => {
    const content = ['"not a docstring statement"', "x = 1"].join("\n");
    // The string IS the first statement, but contains no fence — so we
    // simply emit nothing for the module slot. (Not having a fence is
    // not an E218.)
    expect((await run(content)).hasModuleBlock).toBe(false);
  });
});
