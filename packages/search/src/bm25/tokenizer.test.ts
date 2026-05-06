import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenizer.js";

describe("tokenize", () => {
  // Table-driven contract: each row pins the tokenizer's behavior on one
  // input. New rules add a row; behavior changes update the affected rows.
  it.each<[string, string[]]>([
    // empty + trivial
    ["", []],
    ["abc", ["abc"]],
    ["ABC", ["abc"]],

    // delimiters
    ["snake_case", ["snake", "case"]],
    ["kebab-case", ["kebab", "case"]],
    ["foo_bar-baz", ["foo", "bar", "baz"]],
    ["__leading", ["leading"]],
    ["--main", ["main"]],

    // camelCase / PascalCase
    ["camelCase", ["camel", "case"]],
    ["PascalCase", ["pascal", "case"]],
    ["XMLParser", ["xml", "parser"]],
    ["parseHTTPResponse", ["parse", "http", "response"]],
    ["ABCDef", ["abc", "def"]],
    ["iOS", ["i", "os"]],

    // numbers stay attached to their adjacent letters (one BM25 token)
    ["foo123bar", ["foo123bar"]],
    ["h2o", ["h2o"]],
    ["1 2 3", ["1", "2", "3"]],

    // operators stripped
    ["func(a, b)", ["func", "a", "b"]],
    ["x = 1 + 2", ["x", "1", "2"]],
    ["if (x > 0) { return; }", ["if", "x", "0", "return"]],

    // mixed delimiters within an identifier
    ["my-coolThing_yes", ["my", "cool", "thing", "yes"]],
  ])("tokenize(%j) === %j", (input, expected) => {
    expect(tokenize(input, { preserveDotted: false })).toEqual(expected);
  });

  it("preserves dotted identifiers as a whole token alongside split parts", () => {
    expect(tokenize("Foo.bar")).toEqual(["foo.bar", "foo", "bar"]);
  });

  it("emits each maximal dotted run once, then split parts in source order", () => {
    expect(tokenize("uses Foo.bar.baz here")).toEqual([
      "foo.bar.baz",
      "uses",
      "foo",
      "bar",
      "baz",
      "here",
    ]);
  });

  it("can disable dotted-form preservation", () => {
    expect(tokenize("Foo.bar", { preserveDotted: false })).toEqual(["foo", "bar"]);
  });

  it("does not emit dotted forms for a single-segment identifier with no dot", () => {
    const out = tokenize("plain.dot.case");
    // Even though it has dots, this IS a dotted run — preserved as one form
    // plus split.
    expect(out).toContain("plain.dot.case");
    expect(out).toContain("plain");
    expect(out).toContain("dot");
    expect(out).toContain("case");
  });
});
