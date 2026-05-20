// --diff false-positive corpus (DESIGN-0004 §5 #2 / T17).
//
// Each fixture is a hand-curated diff scenario with the "ground truth" set
// of symbols that an honest --diff report should flag as removed. The CI
// gate (parse-cache.fp.test.ts) computes the FP rate across the corpus and
// asserts it stays ≤ 15%.
//
// Adding a new fixture: append an entry below, then update `expectedSize`
// in the test if it changes the corpus size. Each fixture should isolate
// one ambiguous case — full-file rewrites, delete-and-re-add, partial
// removals, cross-file shadowing, comments mentioning the symbol, etc.

export type DiffFpFixture = {
  /** Short human-readable label — surfaces when the test fails. */
  id: string;
  /** Why this fixture is interesting / what it stress-tests. */
  rationale: string;
  /** Unified-diff text. */
  diff: string;
  /** Hand-curated set of symbols that SHOULD be reported as removed. */
  trueRemoved: readonly string[];
};

export const DIFF_FP_FIXTURES: readonly DiffFpFixture[] = [
  {
    id: "single-fn-removed",
    rationale: "Most basic case: one function removed, one stays as context.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,1 @@",
      "-export function alpha() { return 1; }",
      "-export function beta() { return 2; }",
      " export function gamma() { return 3; }",
    ].join("\n"),
    trueRemoved: ["alpha", "beta"],
  },
  {
    id: "full-rewrite-beta-survives",
    rationale:
      "Full-file rewrite (no shared context). Beta is re-declared on the + side, so the cross-check must NOT flag beta as removed.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,1 @@",
      "-export function alpha() { return 1; }",
      "-export function beta() { return 2; }",
      "+export function beta() { return 2; }",
    ].join("\n"),
    trueRemoved: ["alpha"],
  },
  {
    id: "delete-and-re-add-same-symbol",
    rationale:
      "Delete-and-re-add of a same-named symbol (refactor). Should NOT flag — the symbol still exists.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-export function alpha() { return 1; }",
      "+export function alpha() { return 2; }",
    ].join("\n"),
    trueRemoved: [],
  },
  {
    id: "comment-mention-only",
    rationale:
      "Removed lines mention the symbol but only inside a comment. Heuristic should not match.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,1 @@",
      "-// alpha is the entry point",
      " export function beta() {}",
    ].join("\n"),
    trueRemoved: [],
  },
  {
    id: "string-literal-mention",
    rationale:
      "Removed line contains the symbol as a string literal (e.g., a logger label). Not a declaration; must not flag.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      `-console.log("alpha");`,
      `+console.log("ALPHA");`,
    ].join("\n"),
    trueRemoved: [],
  },
  {
    id: "rename-deferred",
    rationale:
      "Symbol renamed from alpha to alphaTwo. v0.5 ships REMOVED only — rename detection is deferred. We flag the gone name; alphaTwo (new) does not appear.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-export function alpha() { return 1; }",
      "+export function alphaTwo() { return 1; }",
    ].join("\n"),
    trueRemoved: ["alpha"],
  },
  {
    id: "const-arrow-removal",
    rationale: "Arrow-function-valued const removed.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,0 @@",
      "-export const helper = (x: number) => x + 1;",
    ].join("\n"),
    trueRemoved: ["helper"],
  },
  {
    id: "class-removal-with-method-noise",
    rationale:
      "Class declaration removed. Inner method lines should NOT be reported on their own — only the class.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,5 +1,0 @@",
      "-export class Widget {",
      "-  render() {}",
      "-  destroy() {}",
      "-  static of(x: number) { return new Widget(); }",
      "-}",
    ].join("\n"),
    trueRemoved: ["Widget"],
  },
  {
    id: "interface-removal",
    rationale: "TS interface removal.",
    diff: [
      "--- a/src/types.ts",
      "+++ b/src/types.ts",
      "@@ -1,1 +1,0 @@",
      "-export interface Config { name: string }",
    ].join("\n"),
    trueRemoved: ["Config"],
  },
  {
    id: "python-def-removed",
    rationale: "Python `def helper()` removed.",
    diff: [
      "--- a/pkg/util.py",
      "+++ b/pkg/util.py",
      "@@ -1,3 +1,1 @@",
      "-def helper():",
      "-    return 1",
      " def survivor():",
      "     return 2",
    ].join("\n"),
    trueRemoved: ["helper"],
  },
  {
    id: "java-public-class-removed",
    rationale: "Java `public class Foo` removed.",
    diff: [
      "--- a/src/main/java/com/example/Foo.java",
      "+++ b/src/main/java/com/example/Foo.java",
      "@@ -1,3 +1,0 @@",
      "-public class Foo {",
      "-  public int x() { return 1; }",
      "-}",
    ].join("\n"),
    trueRemoved: ["Foo"],
  },
  {
    id: "cross-file-shadow-noise",
    rationale:
      "The target file removes alpha but the diff context (no `-` line) mentions alpha as a parameter or call. Must not double-count.",
    diff: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,5 +1,3 @@",
      "-export function alpha() { return 1; }",
      " function consume(alpha: number) { return alpha + 1; }",
      " export function beta() { return consume(2); }",
    ].join("\n"),
    trueRemoved: ["alpha"],
  },
];
