import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  _resetGoModCacheForTests,
  extractGoImportPath,
  goResolver,
  resolveGoImport,
} from "./go.js";
import type { Chunk } from "../../types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-go-"));
  _resetGoModCacheForTests();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function makeChunk(opts: {
  name: string;
  nodeType: string;
  line: number;
  content: string;
}): Chunk {
  return {
    filePath: "pkg/foo/x.go",
    startLine: opts.line,
    endLine: opts.line,
    language: "go",
    content: opts.content,
    kind: "tree-sitter",
    nodeType: opts.nodeType,
    symbolName: opts.name,
  };
}

describe("extractGoImportPath", () => {
  it("captures the path from a plain quoted import", () => {
    expect(extractGoImportPath(`"fmt"`)).toBe("fmt");
  });

  it("captures the path from an aliased import", () => {
    expect(extractGoImportPath(`f "fmt"`)).toBe("fmt");
  });

  it("captures the path from a side-effect import", () => {
    expect(extractGoImportPath(`_ "image/png"`)).toBe("image/png");
  });

  it("returns null for malformed lines", () => {
    expect(extractGoImportPath(`// not an import`)).toBeNull();
  });
});

describe("resolveGoImport", () => {
  it("resolves a same-module import to a repo-relative directory", async () => {
    await write("go.mod", "module example.com/m\n\ngo 1.22\n");
    await write("internal/util/x.go", "package util\n");
    await write("main.go", `package main\nimport "example.com/m/internal/util"\n`);
    const out = resolveGoImport(
      "example.com/m/internal/util",
      "main.go",
      root,
    );
    expect(out).toBe("internal/util");
  });

  it("returns null for stdlib paths", async () => {
    await write("go.mod", "module example.com/m\n");
    await write("main.go", `package main\nimport "fmt"\n`);
    expect(resolveGoImport("fmt", "main.go", root)).toBeNull();
  });

  it("returns null for third-party paths", async () => {
    await write("go.mod", "module example.com/m\n");
    await write("main.go", `package main\nimport "github.com/x/y"\n`);
    expect(resolveGoImport("github.com/x/y", "main.go", root)).toBeNull();
  });

  it("returns null when no go.mod exists in the tree", async () => {
    await write("main.go", `package main\n`);
    expect(resolveGoImport("anything", "main.go", root)).toBeNull();
  });
});

describe("goResolver.parseFile", () => {
  it("emits exports only for capitalised symbols", () => {
    const source = [
      `package foo`,
      `func Public() {}`,
      `func private() {}`,
      `type Public struct{}`,
    ].join("\n");
    const chunks: Chunk[] = [
      makeChunk({
        name: "Public",
        nodeType: "function_declaration",
        line: 2,
        content: "func Public() {}",
      }),
      makeChunk({
        name: "private",
        nodeType: "function_declaration",
        line: 3,
        content: "func private() {}",
      }),
      makeChunk({
        name: "Public",
        nodeType: "type_declaration",
        line: 4,
        content: "type Public struct{}",
      }),
    ];
    const out = goResolver.parseFile("pkg/foo/x.go", source, chunks);
    const names = out.exports.map((e) => e.name);
    expect(names.filter((n) => n === "private")).toHaveLength(0);
    expect(names.filter((n) => n === "Public")).toHaveLength(2);
  });

  it("captures grouped imports", () => {
    const source = [
      `package main`,
      ``,
      `import (`,
      `    "fmt"`,
      `    "example.com/m/util"`,
      `    _ "image/png"`,
      `)`,
      ``,
      `func main() {}`,
    ].join("\n");
    const out = goResolver.parseFile("main.go", source, []);
    expect(out.imports).toHaveLength(3);
    expect(out.imports.map((i) => i.identifiers[0])).toEqual([
      "fmt",
      "util",
      "png",
    ]);
  });

  it("captures single-line imports", () => {
    const source = [
      `package main`,
      `import "fmt"`,
      `func main() {}`,
    ].join("\n");
    const out = goResolver.parseFile("main.go", source, []);
    expect(out.imports).toHaveLength(1);
    expect(out.imports[0]!.identifiers[0]).toBe("fmt");
  });
});

describe("goResolver.resolveImport (via Resolver iface)", () => {
  it("uses the import-path extraction + module lookup pipeline", async () => {
    await write("go.mod", "module example.com/m\n");
    await write("pkg/util/x.go", "package util\n");
    await write("main.go", `package main\n`);
    const out = goResolver.resolveImport(
      `"example.com/m/pkg/util"`,
      "main.go",
      root,
    );
    expect(out).toBe("pkg/util");
  });
});
