import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildSymbolIndex, refreshSymbolIndex } from "./symbol-index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-explain-sym-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("buildSymbolIndex", () => {
  it("indexes a small TypeScript repo and resolves relative imports", async () => {
    await write("src/a.ts", [
      `import { bee } from "./b.js";`,
      `export function a() { return bee(); }`,
    ].join("\n"));
    await write("src/b.ts", [
      `export function bee() { return 1; }`,
    ].join("\n"));

    const index = await buildSymbolIndex(root);
    expect(index.size()).toBe(2);

    const entryA = index.get("src/a.ts")!;
    expect(entryA.language).toBe("typescript");
    expect(entryA.exports.map((e) => e.name)).toContain("a");
    expect(entryA.imports).toHaveLength(1);
    expect(entryA.imports[0]!.resolved).toBe("src/b.ts");

    const entryB = index.get("src/b.ts")!;
    expect(entryB.exports.map((e) => e.name)).toContain("bee");
    expect(entryB.imports).toHaveLength(0);
  });

  it("substitutes commitCounts when supplied", async () => {
    await write("src/a.ts", "export const x = 1;\n");
    const counts = new Map<string, number>([["src/a.ts", 42]]);
    const index = await buildSymbolIndex(root, { commitCounts: counts });
    expect(index.get("src/a.ts")!.commitCount).toBe(42);
  });

  it("records language=null for files outside the supported set", async () => {
    await write("docs/notes.txt", "plain text\n");
    const index = await buildSymbolIndex(root);
    const entry = index.get("docs/notes.txt")!;
    expect(entry.language).toBeNull();
    expect(entry.exports).toEqual([]);
    expect(entry.imports).toEqual([]);
  });

  it("records language but no exports for languages without a resolver yet", async () => {
    // Rust is detected by extension but has no resolver as of v0.5 — the
    // index entry should carry the language tag with empty exports/imports.
    await write("src/lib.rs", "pub fn hello() -> i32 { 1 }\n");
    const index = await buildSymbolIndex(root);
    const entry = index.get("src/lib.rs")!;
    expect(entry.language).toBe("rust");
    expect(entry.exports).toEqual([]);
    expect(entry.imports).toEqual([]);
  });

  it("uses the supplied stateId metadata", async () => {
    await write("src/a.ts", "export const x = 1;\n");
    const index = await buildSymbolIndex(root, { stateId: "abc123" });
    expect(index.stateId).toBe("abc123");
  });
});

describe("refreshSymbolIndex", () => {
  it("re-parses modified files, drops removed, adds new ones", async () => {
    await write("src/a.ts", "export function alpha() { return 1; }\n");
    await write("src/b.ts", "export function bravo() { return 1; }\n");
    const base = await buildSymbolIndex(root);
    expect(base.size()).toBe(2);

    // Mutate the on-disk state to match the delta we're going to apply.
    await write("src/a.ts", [
      `export function alpha() { return 1; }`,
      `export function alphaTwo() { return 2; }`,
    ].join("\n"));
    await rm(join(root, "src/b.ts"));
    await write("src/c.ts", "export function charlie() { return 1; }\n");

    const refreshed = await refreshSymbolIndex(base, {
      modified: ["src/a.ts"],
      added: ["src/c.ts"],
      removed: ["src/b.ts"],
    });
    expect(refreshed.size()).toBe(2);
    expect(refreshed.get("src/a.ts")!.exports.map((e) => e.name)).toEqual(
      expect.arrayContaining(["alpha", "alphaTwo"]),
    );
    expect(refreshed.get("src/b.ts")).toBeUndefined();
    expect(refreshed.get("src/c.ts")!.exports.map((e) => e.name)).toEqual([
      "charlie",
    ]);
  });

  it("preserves commitCount for files that are not in the delta", async () => {
    await write("src/a.ts", "export function alpha() { return 1; }\n");
    await write("src/b.ts", "export function bravo() { return 1; }\n");
    const base = await buildSymbolIndex(root, {
      commitCounts: new Map([
        ["src/a.ts", 3],
        ["src/b.ts", 7],
      ]),
    });
    await write("src/a.ts", "export function alpha() { return 2; }\n");
    const refreshed = await refreshSymbolIndex(base, {
      modified: ["src/a.ts"],
      added: [],
      removed: [],
    });
    expect(refreshed.get("src/b.ts")!.commitCount).toBe(7);
    // commitCount falls back to the prior value when no new map is supplied.
    expect(refreshed.get("src/a.ts")!.commitCount).toBe(3);
  });
});
