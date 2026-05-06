import { describe, expect, it } from "vitest";
import { detectLanguage } from "./language.js";

describe("detectLanguage", () => {
  it.each([
    ["src/foo.ts", "typescript"],
    ["foo.tsx", "tsx"],
    ["foo.mjs", "javascript"],
    ["foo.cjs", "javascript"],
    ["snake/case_path.py", "python"],
    ["pkg/Bar.java", "java"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    ["a/b/c.cpp", "cpp"],
    ["a/b/c.cc", "cpp"],
    ["foo.cs", "csharp"],
    ["foo.rb", "ruby"],
    ["foo.kt", "kotlin"],
    ["foo.kts", "kotlin"],
    ["foo.scala", "scala"],
    ["foo.php", "php"],
    ["foo.swift", "swift"],
    // Case-insensitive
    ["FOO.TS", "typescript"],
    // Windows-style separators
    ["src\\nested\\foo.py", "python"],
  ])("recognizes %s as %s", (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });

  it.each([
    ["README", null],
    [".gitignore", null],
    [".bashrc", null],
    ["unknown.xyz", null],
    ["Dockerfile", null],
  ])("returns null for %s", (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });
});
