import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  extractJavaImportPath,
  findJavaSourceRoot,
  javaResolver,
  parseJavaPackage,
  resolveJavaImport,
} from "./java.js";
import type { Chunk } from "../../types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-java-"));
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
    filePath: "src/main/java/com/example/Foo.java",
    startLine: opts.line,
    endLine: opts.line,
    language: "java",
    content: opts.content,
    kind: "tree-sitter",
    nodeType: opts.nodeType,
    symbolName: opts.name,
  };
}

describe("parseJavaPackage", () => {
  it("parses a standard package declaration", () => {
    expect(parseJavaPackage("package com.example.foo;\n\nclass X{}\n")).toEqual([
      "com",
      "example",
      "foo",
    ]);
  });

  it("returns [] for the default package", () => {
    expect(parseJavaPackage("class X{}\n")).toEqual([]);
  });
});

describe("findJavaSourceRoot", () => {
  it("strips the package segments from the file's directory", () => {
    const root = findJavaSourceRoot(
      "/repo/src/main/java/com/example/foo/X.java",
      ["com", "example", "foo"],
    );
    expect(root).toBe("/repo/src/main/java");
  });

  it("returns null when the dir layout does not match the package", () => {
    const root = findJavaSourceRoot(
      "/repo/wrong/path/X.java",
      ["com", "example"],
    );
    expect(root).toBeNull();
  });

  it("returns the file's dir when the package is empty", () => {
    const root = findJavaSourceRoot("/repo/X.java", []);
    expect(root).toBe("/repo");
  });
});

describe("extractJavaImportPath", () => {
  it("parses a plain import", () => {
    expect(extractJavaImportPath("import com.example.Foo;")).toEqual({
      path: "com.example.Foo",
      isWildcard: false,
      isStatic: false,
    });
  });

  it("parses a static import", () => {
    expect(extractJavaImportPath("import static com.example.Foo.bar;")).toEqual({
      path: "com.example.Foo.bar",
      isWildcard: false,
      isStatic: true,
    });
  });

  it("parses a wildcard import", () => {
    expect(extractJavaImportPath("import com.example.*;")).toEqual({
      path: "com.example",
      isWildcard: true,
      isStatic: false,
    });
  });

  it("returns null for non-imports", () => {
    expect(extractJavaImportPath("class X{}")).toBeNull();
  });
});

describe("resolveJavaImport", () => {
  it("resolves a same-source-root import to its .java file", async () => {
    await write(
      "src/main/java/com/example/Foo.java",
      `package com.example;\nimport com.example.Bar;\nclass Foo{}\n`,
    );
    await write(
      "src/main/java/com/example/Bar.java",
      `package com.example;\nclass Bar{}\n`,
    );
    const fooSrc = `package com.example;\nimport com.example.Bar;\nclass Foo{}\n`;
    const out = resolveJavaImport(
      "import com.example.Bar;",
      "src/main/java/com/example/Foo.java",
      root,
      fooSrc,
    );
    expect(out).toBe("src/main/java/com/example/Bar.java");
  });

  it("resolves a wildcard import to the package directory", async () => {
    await write(
      "src/main/java/com/example/Foo.java",
      `package com.example;\nimport com.example.sub.*;\nclass Foo{}\n`,
    );
    await write(
      "src/main/java/com/example/sub/Inner.java",
      `package com.example.sub;\nclass Inner{}\n`,
    );
    const out = resolveJavaImport(
      "import com.example.sub.*;",
      "src/main/java/com/example/Foo.java",
      root,
      `package com.example;\n`,
    );
    expect(out).toBe("src/main/java/com/example/sub");
  });

  it("falls back for static imports to the enclosing class file", async () => {
    await write(
      "src/main/java/com/example/Foo.java",
      `package com.example;\nclass Foo{}\n`,
    );
    await write(
      "src/main/java/com/example/Util.java",
      `package com.example;\nclass Util{}\n`,
    );
    const out = resolveJavaImport(
      "import static com.example.Util.foo;",
      "src/main/java/com/example/Foo.java",
      root,
      `package com.example;\n`,
    );
    expect(out).toBe("src/main/java/com/example/Util.java");
  });

  it("returns null for stdlib imports", () => {
    const out = resolveJavaImport(
      "import java.util.List;",
      "src/main/java/com/example/Foo.java",
      root,
      `package com.example;\n`,
    );
    expect(out).toBeNull();
  });
});

describe("javaResolver.parseFile", () => {
  it("emits exports for top-level types and public methods only", () => {
    const source = `
package com.example;

public class Foo {
  public void doPublic() {}
  private void doPrivate() {}
}
    `.trim();
    const chunks: Chunk[] = [
      makeChunk({
        name: "Foo",
        nodeType: "class_declaration",
        line: 3,
        content: "public class Foo {",
      }),
      makeChunk({
        name: "doPublic",
        nodeType: "method_declaration",
        line: 4,
        content: "  public void doPublic() {}",
      }),
      makeChunk({
        name: "doPrivate",
        nodeType: "method_declaration",
        line: 5,
        content: "  private void doPrivate() {}",
      }),
    ];
    const out = javaResolver.parseFile(
      "src/main/java/com/example/Foo.java",
      source,
      chunks,
    );
    const names = out.exports.map((e) => e.name);
    expect(names).toContain("Foo");
    expect(names).toContain("doPublic");
    expect(names).not.toContain("doPrivate");
  });

  it("detects a public member whose chunk carries a leading @sivru Javadoc (regression: annotated symbols dropped)", () => {
    // The chunker prepends the Javadoc to chunk.content; a 7+ line @sivru block
    // pushes `public` past the 3-line visibility window, which used to drop the
    // member from the public API and 404 region explain on it.
    const content = [
      "  /**",
      "   * @sivru",
      "   * schema: 1",
      "   * role: widget-maker",
      "   * responsibility: make widgets",
      "   * @end",
      "   */",
      "  public void make() {}",
    ].join("\n");
    const chunks: Chunk[] = [
      makeChunk({
        name: "make",
        nodeType: "method_declaration",
        line: 8,
        content,
      }),
      makeChunk({
        name: "hidden",
        nodeType: "method_declaration",
        line: 18,
        content: [
          "  /**",
          "   * @sivru",
          "   * schema: 1",
          "   * role: helper",
          "   * responsibility: internal",
          "   * @end",
          "   */",
          "  private void hidden() {}",
        ].join("\n"),
      }),
    ];
    const out = javaResolver.parseFile(
      "src/main/java/com/example/Foo.java",
      "",
      chunks,
    );
    expect(out.exports.map((e) => e.name)).toEqual(["make"]);
    expect(out.exports[0]!.signature).toBe("public void make() {}");
  });

  it("captures all top-level imports", () => {
    const source = [
      `package com.example;`,
      `import com.foo.A;`,
      `import com.bar.*;`,
      `import static com.baz.Z.thing;`,
      `class Foo{}`,
    ].join("\n");
    const out = javaResolver.parseFile(
      "src/main/java/com/example/Foo.java",
      source,
      [],
    );
    expect(out.imports).toHaveLength(3);
    expect(out.imports[0]!.identifiers).toEqual(["A"]);
    // Wildcard imports record no specific local identifier.
    expect(out.imports[1]!.identifiers).toEqual([]);
  });
});
