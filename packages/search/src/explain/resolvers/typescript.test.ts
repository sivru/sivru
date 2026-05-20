import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  extractImportSpecifier,
  extractImportedIdentifiers,
  typescriptResolver,
} from "./typescript.js";
import type { Chunk } from "../../types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-ts-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("extractImportedIdentifiers", () => {
  it("captures a default import", () => {
    expect(extractImportedIdentifiers(`import Foo from "./foo"`)).toEqual(["Foo"]);
  });

  it("captures a namespace import", () => {
    expect(extractImportedIdentifiers(`import * as Foo from "./foo"`)).toEqual(["Foo"]);
  });

  it("captures named imports including aliases (local name)", () => {
    expect(
      extractImportedIdentifiers(`import { a, b as c } from "./foo"`),
    ).toEqual(["a", "c"]);
  });

  it("captures default + named imports together", () => {
    expect(
      extractImportedIdentifiers(`import Foo, { bar, baz as qux } from "./foo"`),
    ).toEqual(["Foo", "bar", "qux"]);
  });

  it("returns [] for a side-effect import", () => {
    expect(extractImportedIdentifiers(`import "./foo.css"`)).toEqual([]);
  });
});

describe("extractImportSpecifier", () => {
  it("pulls the spec from a `from \"...\"` import", () => {
    expect(extractImportSpecifier(`import Foo from "./foo"`)).toBe("./foo");
  });

  it("pulls the spec from a side-effect import", () => {
    expect(extractImportSpecifier(`import "./foo.css"`)).toBe("./foo.css");
  });

  it("returns null when no specifier is present", () => {
    expect(extractImportSpecifier("export default foo;")).toBeNull();
  });
});

describe("typescriptResolver.resolveImport", () => {
  it("resolves `./foo` to a sibling `.ts` file", async () => {
    await write("src/a.ts", "export const x = 1;\n");
    await write("src/foo.ts", "export const y = 1;\n");
    const out = typescriptResolver.resolveImport(
      `import { y } from "./foo"`,
      "src/a.ts",
      root,
    );
    expect(out).toBe("src/foo.ts");
  });

  it("resolves `./foo.js` to a sibling `.ts` file (NodeNext re-map)", async () => {
    await write("src/a.ts", "export const x = 1;\n");
    await write("src/foo.ts", "export const y = 1;\n");
    const out = typescriptResolver.resolveImport(
      `import { y } from "./foo.js"`,
      "src/a.ts",
      root,
    );
    expect(out).toBe("src/foo.ts");
  });

  it("resolves `./bar/` directory to its `index.ts`", async () => {
    await write("src/a.ts", "export const x = 1;\n");
    await write("src/bar/index.ts", "export const z = 1;\n");
    const out = typescriptResolver.resolveImport(
      `import { z } from "./bar"`,
      "src/a.ts",
      root,
    );
    expect(out).toBe("src/bar/index.ts");
  });

  it("returns null for bare specifiers (external packages, type-only stubs)", () => {
    const out = typescriptResolver.resolveImport(
      `import { something } from "react"`,
      "src/a.ts",
      root,
    );
    expect(out).toBeNull();
  });

  it("returns null when the relative target does not exist", () => {
    const out = typescriptResolver.resolveImport(
      `import { something } from "./missing"`,
      "src/a.ts",
      root,
    );
    expect(out).toBeNull();
  });
});

describe("typescriptResolver.parseFile", () => {
  function makeChunk(opts: {
    name: string;
    nodeType: string;
    line: number;
    content: string;
  }): Chunk {
    return {
      filePath: "src/a.ts",
      startLine: opts.line,
      endLine: opts.line,
      language: "typescript",
      content: opts.content,
      kind: "tree-sitter",
      nodeType: opts.nodeType,
      symbolName: opts.name,
    };
  }

  it("emits exports for exported declarations only", () => {
    const source = [
      `export function pub() { return 1; }`,
      `function priv() { return 2; }`,
      `export class C {}`,
    ].join("\n");
    const chunks: Chunk[] = [
      makeChunk({
        name: "pub",
        nodeType: "function_declaration",
        line: 1,
        content: "export function pub() { return 1; }",
      }),
      makeChunk({
        name: "priv",
        nodeType: "function_declaration",
        line: 2,
        content: "function priv() { return 2; }",
      }),
      makeChunk({
        name: "C",
        nodeType: "class_declaration",
        line: 3,
        content: "export class C {}",
      }),
    ];
    const out = typescriptResolver.parseFile("src/a.ts", source, chunks);
    expect(out.exports.map((e) => e.name).sort()).toEqual(["C", "pub"]);
    const pub = out.exports.find((e) => e.name === "pub")!;
    expect(pub.kind).toBe("function");
    const c = out.exports.find((e) => e.name === "C")!;
    expect(c.kind).toBe("class");
  });

  it("extracts raw imports and their identifiers", () => {
    const source = [
      `import Foo from "./foo";`,
      `import { bar, baz as qux } from "./bar.js";`,
      `// trailing code`,
    ].join("\n");
    const out = typescriptResolver.parseFile("src/a.ts", source, []);
    expect(out.imports).toHaveLength(2);
    expect(out.imports[0]!.identifiers).toEqual(["Foo"]);
    expect(out.imports[1]!.identifiers).toEqual(["bar", "qux"]);
  });
});
