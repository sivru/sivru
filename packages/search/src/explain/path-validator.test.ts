import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  parsePathAndSymbol,
  resolveAndAssertInside,
  validateRelPathSyntax,
} from "./path-validator.js";
import { SivruExplainError } from "./types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-path-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("parsePathAndSymbol", () => {
  it("splits on the first '::' separator", () => {
    expect(parsePathAndSymbol("src/foo.ts::bar")).toEqual({
      path: "src/foo.ts",
      symbol: "bar",
    });
  });

  it("returns null symbol when '::' is absent", () => {
    expect(parsePathAndSymbol("src/foo.ts")).toEqual({
      path: "src/foo.ts",
      symbol: null,
    });
  });

  it("keeps later '::' inside the symbol portion", () => {
    expect(parsePathAndSymbol("src/foo.ts::Bar::baz")).toEqual({
      path: "src/foo.ts",
      symbol: "Bar::baz",
    });
  });
});

describe("validateRelPathSyntax", () => {
  it("accepts a plain relative path", () => {
    expect(() => validateRelPathSyntax("src/foo.ts")).not.toThrow();
  });

  it("rejects empty string with SIVRU-E2001", () => {
    expect(() => validateRelPathSyntax("")).toThrow(SivruExplainError);
    try {
      validateRelPathSyntax("");
    } catch (e) {
      expect((e as SivruExplainError).code).toBe("SIVRU-E2001");
    }
  });

  it("rejects absolute paths with SIVRU-E2001", () => {
    try {
      validateRelPathSyntax("/etc/passwd");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SivruExplainError);
      expect((e as SivruExplainError).code).toBe("SIVRU-E2001");
    }
  });

  it("rejects parent-directory segments with SIVRU-E2001", () => {
    try {
      validateRelPathSyntax("../etc/passwd");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SivruExplainError).code).toBe("SIVRU-E2001");
    }
    try {
      validateRelPathSyntax("src/../etc/passwd");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SivruExplainError).code).toBe("SIVRU-E2001");
    }
  });
});

describe("resolveAndAssertInside", () => {
  it("returns the realpath for a file inside the repo", async () => {
    await write("src/foo.ts", "export const x = 1;\n");
    const real = await resolveAndAssertInside("src/foo.ts", root);
    const expected = await realpath(resolve(root, "src/foo.ts"));
    expect(real).toBe(expected);
  });

  it("throws SIVRU-E2009 when the file does not exist but path is legal", async () => {
    try {
      await resolveAndAssertInside("src/missing.ts", root);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SivruExplainError);
      expect((e as SivruExplainError).code).toBe("SIVRU-E2009");
    }
  });

  it("rejects a symlink that points outside the repo with SIVRU-E2002", async () => {
    const outside = await mkdtemp(join(tmpdir(), "sivru-explain-outside-"));
    try {
      await write("dummy.ts", "// keeps src/ around\n");
      // Inside-repo symlink pointing outside the repo
      await symlink(outside, join(root, "escape"));
      try {
        await resolveAndAssertInside("escape", root);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SivruExplainError);
        expect((e as SivruExplainError).code).toBe("SIVRU-E2002");
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths via the syntactic layer", async () => {
    try {
      await resolveAndAssertInside("/etc/passwd", root);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SivruExplainError).code).toBe("SIVRU-E2001");
    }
  });
});
