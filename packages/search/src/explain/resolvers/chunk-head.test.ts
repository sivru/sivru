import { describe, expect, it } from "vitest";

import { codeHead } from "./chunk-head.js";

describe("codeHead", () => {
  it("skips a multi-line @sivru block and returns the declaration", () => {
    const content = [
      "/**",
      " * @sivru",
      " * schema: 1",
      " * role: r",
      " * responsibility: x",
      " * @end",
      " */",
      "export function makeWidget(): void {}",
    ].join("\n");
    expect(codeHead(content, 1)).toBe("export function makeWidget(): void {}");
  });

  it("skips // line comments", () => {
    expect(codeHead("// a\n// b\nexport const x = 1;", 1)).toBe(
      "export const x = 1;",
    );
  });

  it("strips a complete inline block comment but keeps the code on that line", () => {
    // The keyword check uses \bexport\b and the signature path trims, so
    // leading whitespace left by the strip is harmless — assert on the code.
    expect(codeHead("/* doc */ export class C {}", 1).trim()).toBe(
      "export class C {}",
    );
  });

  it("returns the first N code lines, comments not counted", () => {
    const content = "// c\nexport function a() {}\nexport function b() {}";
    expect(codeHead(content, 2).split("\n")).toHaveLength(2);
  });

  it("passes through code with no leading comment", () => {
    expect(codeHead("export function f() {}", 1)).toBe("export function f() {}");
  });

  it("returns empty string for comment-only content", () => {
    expect(codeHead("/**\n * just docs\n */", 3)).toBe("");
  });
});
