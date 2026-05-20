import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseFromSpec,
  parseImportSpec,
  pythonResolver,
} from "./python.js";
import type { Chunk } from "../../types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-py-"));
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
    filePath: "pkg/mod.py",
    startLine: opts.line,
    endLine: opts.line,
    language: "python",
    content: opts.content,
    kind: "tree-sitter",
    nodeType: opts.nodeType,
    symbolName: opts.name,
  };
}

describe("parseFromSpec", () => {
  it("parses `from .foo import a, b as c`", () => {
    const out = parseFromSpec("from .foo import a, b as c");
    expect(out).toEqual({
      leadingDots: 1,
      module: "foo",
      identifiers: ["a", "c"],
    });
  });

  it("parses `from ..pkg.sub import bar`", () => {
    const out = parseFromSpec("from ..pkg.sub import bar");
    expect(out).toEqual({
      leadingDots: 2,
      module: "pkg.sub",
      identifiers: ["bar"],
    });
  });

  it("parses absolute `from pkg import a`", () => {
    const out = parseFromSpec("from pkg import a");
    expect(out).toEqual({
      leadingDots: 0,
      module: "pkg",
      identifiers: ["a"],
    });
  });

  it("parses `from . import x`", () => {
    const out = parseFromSpec("from . import x");
    expect(out).toEqual({
      leadingDots: 1,
      module: "",
      identifiers: ["x"],
    });
  });

  it("returns empty identifiers for star imports", () => {
    const out = parseFromSpec("from pkg import *");
    expect(out?.identifiers).toEqual([]);
  });

  it("handles parenthesised multi-line imports", () => {
    const out = parseFromSpec("from pkg import (a, b, c,)");
    expect(out?.identifiers).toEqual(["a", "b", "c"]);
  });
});

describe("parseImportSpec", () => {
  it("captures the top-level name for `import a.b.c`", () => {
    expect(parseImportSpec("import a.b.c")).toEqual({
      module: "a.b.c",
      localNames: ["a"],
    });
  });

  it("captures the alias for `import a.b as c`", () => {
    expect(parseImportSpec("import a.b as c")).toEqual({
      module: "a.b",
      localNames: ["c"],
    });
  });
});

describe("pythonResolver.resolveImport", () => {
  it("resolves `from .foo import a` to a sibling .py file", async () => {
    await write("pkg/mod.py", "from .foo import a\n");
    await write("pkg/foo.py", "def a(): return 1\n");
    const out = pythonResolver.resolveImport(
      "from .foo import a",
      "pkg/mod.py",
      root,
    );
    expect(out).toBe("pkg/foo.py");
  });

  it("resolves `from .pkg import x` to a package __init__.py", async () => {
    await write("pkg/mod.py", "from .sub import x\n");
    await write("pkg/sub/__init__.py", "def x(): return 1\n");
    const out = pythonResolver.resolveImport(
      "from .sub import x",
      "pkg/mod.py",
      root,
    );
    expect(out).toBe("pkg/sub/__init__.py");
  });

  it("resolves `from ..foo import x` to a package one level up", async () => {
    await write("pkg/sub/mod.py", "from ..foo import x\n");
    await write("pkg/foo.py", "def x(): return 1\n");
    const out = pythonResolver.resolveImport(
      "from ..foo import x",
      "pkg/sub/mod.py",
      root,
    );
    expect(out).toBe("pkg/foo.py");
  });

  it("returns null for absolute imports (v0.5 scope)", () => {
    expect(
      pythonResolver.resolveImport(
        "from pkg.sub import x",
        "pkg/mod.py",
        root,
      ),
    ).toBeNull();
    expect(
      pythonResolver.resolveImport("import os", "pkg/mod.py", root),
    ).toBeNull();
  });

  it("returns null when the relative target is missing", () => {
    const out = pythonResolver.resolveImport(
      "from .missing import x",
      "pkg/mod.py",
      root,
    );
    expect(out).toBeNull();
  });
});

describe("pythonResolver.parseFile", () => {
  it("emits exports for top-level public function/class definitions only", () => {
    const source = [
      `def hello():`,
      `    return 1`,
      ``,
      `def _private():`,
      `    return 2`,
      ``,
      `class Public:`,
      `    pass`,
    ].join("\n");
    const chunks: Chunk[] = [
      makeChunk({
        name: "hello",
        nodeType: "function_definition",
        line: 1,
        content: "def hello():\n    return 1\n",
      }),
      makeChunk({
        name: "_private",
        nodeType: "function_definition",
        line: 4,
        content: "def _private():\n    return 2\n",
      }),
      makeChunk({
        name: "Public",
        nodeType: "class_definition",
        line: 7,
        content: "class Public:\n    pass\n",
      }),
    ];
    const out = pythonResolver.parseFile("pkg/mod.py", source, chunks);
    expect(out.exports.map((e) => e.name).sort()).toEqual(["Public", "hello"]);
  });

  it("extracts top-level imports with their bound names", () => {
    const source = [
      `import os`,
      `from .foo import a, b as c`,
      `from pkg import x`,
      ``,
      `def hello():`,
      `    import inside  # nested - should be ignored`,
    ].join("\n");
    const out = pythonResolver.parseFile("pkg/mod.py", source, []);
    expect(out.imports).toHaveLength(3);
    expect(out.imports[0]!.identifiers).toEqual(["os"]);
    expect(out.imports[1]!.identifiers).toEqual(["a", "c"]);
    expect(out.imports[2]!.identifiers).toEqual(["x"]);
  });
});
