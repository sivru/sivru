// TypeScript module-locator tests (DESIGN-0016 §3).

import { describe, expect, it } from "vitest";

import { extractBlocks } from "../extract.js";

async function run(content: string): Promise<{
  hasModuleBlock: boolean;
}> {
  const out = await extractBlocks("/tmp/test-locator.ts", {
    content,
    language: "typescript",
  });
  return { hasModuleBlock: out.some((b) => b.kind === "module") };
}

describe("typescriptModuleLocator — top-of-file", () => {
  it("recognizes a top-of-file `/** */` block comment as module carrier", async () => {
    const content = [
      "/**",
      " * @sivru",
      " * schema: 1",
      " * role: r",
      " * responsibility: p",
      " * @end",
      " */",
      "",
      "export const PACKAGE = 'pkg';",
    ].join("\n");
    expect((await run(content)).hasModuleBlock).toBe(true);
  });

  it("recognizes a top-of-file `//` comment run as module carrier", async () => {
    const content = [
      "// @sivru",
      "// schema: 1",
      "// role: r",
      "// responsibility: p",
      "// @end",
      "",
      "export const PACKAGE = 'pkg';",
    ].join("\n");
    expect((await run(content)).hasModuleBlock).toBe(true);
  });

  it("does NOT match a comment that comes after a real statement", async () => {
    const content = [
      "export const PACKAGE = 'pkg';",
      "/**",
      " * @sivru",
      " * schema: 1",
      " * role: r",
      " * responsibility: p",
      " * @end",
      " */",
    ].join("\n");
    expect((await run(content)).hasModuleBlock).toBe(false);
  });
});
