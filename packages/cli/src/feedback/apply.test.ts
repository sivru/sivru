import { relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { applyBlockEdits, type ApplyDeps } from "./apply.js";
import type { BlockEdit, FeedbackPatch } from "./patch.js";

// applyBlockEdits resolves sourcePath against the repo root, so the injected
// deps must key files the same way — and cross-platform (Windows uses `\`).
const ROOT = resolve("/repo");
const keyOf = (p: string): string => relative(ROOT, p).split(sep).join("/");

// A fixture source file with one @sivru block on `doThing`.
const SRC = [
  "/**",
  " * @sivru",
  " * schema: 1",
  " * role: worker",
  " * responsibility: do the thing",
  " * collaborators: [helper, parse]",
  " * maturity: stable",
  " * @end",
  " */",
  "export function doThing() {}",
].join("\n");

const BLOCK = {
  schema: 1,
  role: "worker",
  responsibility: "do the thing",
  collaborators: ["helper", "parse"],
  maturity: "stable",
};
const BLOCK_HASH = "h1";

function deps(over: Partial<ApplyDeps> = {}, files: Record<string, string> = { "x.ts": SRC }) {
  const written: Record<string, string> = {};
  const base: ApplyDeps = {
    readFile: async (p) => {
      const rel = keyOf(p);
      if (!(rel in files)) throw new Error("ENOENT");
      return files[rel]!;
    },
    writeFile: async (p, c) => {
      written[keyOf(p)] = c;
    },
    extract: async () => [
      { symbolName: "doThing", block: BLOCK, range: { startLine: 2, endLine: 8 } },
    ],
    hash: () => BLOCK_HASH,
    isDirty: async () => false,
    ...over,
  };
  return { base, written };
}

function patch(edits: BlockEdit[]): FeedbackPatch {
  return { schema: 1, repoRoot: "/repo", head: "abc1234", edits };
}

const edit = (over: Partial<BlockEdit> & { edit: BlockEdit["edit"] }): BlockEdit => ({
  targetNodeId: "symbol:x.ts#doThing",
  sourcePath: "x.ts",
  blockSymbolName: "doThing",
  blockContentHash: BLOCK_HASH,
  ...over,
});

describe("applyBlockEdits — happy path + source integrity", () => {
  it("sets a scalar field, changing ONLY that line", async () => {
    const { base, written } = deps();
    const r = await applyBlockEdits(
      patch([edit({ edit: { field: "responsibility", op: "set", value: "do the NEW thing" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.ok).toBe(true);
    expect(r.filesWritten).toEqual(["x.ts"]);
    const out = written["x.ts"]!.split("\n");
    expect(out[4]).toBe(" * responsibility: do the NEW thing"); // line 5
    // every other line byte-identical
    const src = SRC.split("\n");
    out.forEach((l, i) => i !== 4 && expect(l).toBe(src[i]));
  });

  it("sets the inline collaborators array", async () => {
    const { base, written } = deps();
    await applyBlockEdits(
      patch([edit({ edit: { field: "collaborators", op: "set", value: ["helper", "parse", "newOne"] } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(written["x.ts"]!.split("\n")[5]).toBe(" * collaborators: [helper, parse, newOne]");
  });

  it("quotes a scalar value containing a colon (YAML-safe)", async () => {
    const { base, written } = deps();
    await applyBlockEdits(
      patch([edit({ edit: { field: "responsibility", op: "set", value: "does X: then Y" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(written["x.ts"]!.split("\n")[4]).toBe(' * responsibility: "does X: then Y"');
  });

  it("quotes number/bool/null-looking values so YAML keeps them strings", async () => {
    for (const v of ["123", "true", "null", "1.5e3"]) {
      const { base, written } = deps();
      await applyBlockEdits(
        patch([edit({ edit: { field: "role", op: "set", value: v } })]),
        { repoRoot: "/repo", deps: base },
      );
      expect(written["x.ts"]!.split("\n")[3]).toBe(` * role: "${v}"`);
    }
    // a normal word stays unquoted
    const { base, written } = deps();
    await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "engine" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(written["x.ts"]!.split("\n")[3]).toBe(" * role: engine");
  });

  it("batches two edits to the SAME block into one write (no self-staling)", async () => {
    const { base, written } = deps();
    const r = await applyBlockEdits(
      patch([
        edit({ edit: { field: "role", op: "set", value: "engine" } }),
        edit({ edit: { field: "maturity", op: "set", value: "experimental" } }),
      ]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes.every((o) => o.status === "applied")).toBe(true);
    const out = written["x.ts"]!.split("\n");
    expect(out[3]).toBe(" * role: engine");
    expect(out[6]).toBe(" * maturity: experimental");
  });
});

describe("applyBlockEdits — refusals (never corrupt)", () => {
  it("refuses a stale block (hash mismatch) and writes nothing", async () => {
    const { base, written } = deps();
    const r = await applyBlockEdits(
      patch([edit({ blockContentHash: "OLD", edit: { field: "role", op: "set", value: "x" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.ok).toBe(false);
    expect(r.outcomes[0]!.status).toBe("stale");
    expect(written["x.ts"]).toBeUndefined();
  });

  it("refuses a missing symbol", async () => {
    const { base } = deps({ extract: async () => [] });
    const r = await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "x" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("not-found");
  });

  it("refuses an ambiguous symbol (two identical blocks)", async () => {
    const { base } = deps({
      extract: async () => [
        { symbolName: "doThing", block: BLOCK, range: { startLine: 2, endLine: 8 } },
        { symbolName: "doThing", block: BLOCK, range: { startLine: 20, endLine: 26 } },
      ],
    });
    const r = await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "x" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("ambiguous");
  });

  it("refuses setting a field that isn't present (adding fields deferred)", async () => {
    const noMat = SRC.replace(" * maturity: stable\n", "");
    const { base } = deps({}, { "x.ts": noMat });
    const r = await applyBlockEdits(
      patch([edit({ edit: { field: "maturity", op: "set", value: "stable" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("field-absent");
  });

  it("refuses a missing file (reported, not silently dropped)", async () => {
    const { base } = deps({}, {});
    const r = await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "x" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("not-found");
    expect(r.ok).toBe(false);
  });

  it("refuses a sourcePath that escapes the repo root (path traversal)", async () => {
    const { base, written } = deps();
    for (const bad of ["../../etc/passwd", "/etc/passwd"]) {
      const r = await applyBlockEdits(
        patch([edit({ sourcePath: bad, edit: { field: "role", op: "set", value: "x" } })]),
        { repoRoot: "/repo", deps: base },
      );
      expect(r.outcomes[0]!.status).toBe("escapes-repo");
    }
    expect(Object.keys(written)).toEqual([]); // nothing written anywhere
  });

  it("escapes a newline in a value so it can't split the source line", async () => {
    const { base, written } = deps();
    await applyBlockEdits(
      patch([edit({ edit: { field: "responsibility", op: "set", value: "line one\nline two" } })]),
      { repoRoot: "/repo", deps: base },
    );
    const out = written["x.ts"]!.split("\n");
    expect(out).toHaveLength(SRC.split("\n").length); // no extra line
    expect(out[4]).toBe(' * responsibility: "line one\\nline two"'); // \n escaped
  });
});

describe("applyBlockEdits — create a block (the un-annotated path)", () => {
  const NO_BLOCK = "export function foo() {}\n";
  const create = (over: Partial<import("./patch.js").CreateEdit> = {}) => ({
    schema: 1 as const,
    repoRoot: "/repo",
    head: "h",
    edits: [],
    creates: [
      {
        targetNodeId: "symbol:x.ts#foo",
        sourcePath: "x.ts",
        blockSymbolName: "foo",
        declLine: 1,
        role: "worker",
        responsibility: "do the foo",
        ...over,
      },
    ],
  });

  it("inserts a minimal @sivru block above the declaration", async () => {
    const { base, written } = deps({ extract: async () => [] }, { "x.ts": NO_BLOCK });
    const r = await applyBlockEdits(create(), { repoRoot: "/repo", deps: base });
    expect(r.ok).toBe(true);
    const out = written["x.ts"]!;
    expect(out).toContain("/**");
    expect(out).toContain(" * @sivru");
    expect(out).toContain(" * role: worker");
    expect(out).toContain(" * responsibility: do the foo");
    // the block is ABOVE the declaration, which is untouched
    expect(out.indexOf("@sivru")).toBeLessThan(out.indexOf("export function foo"));
    expect(out).toContain("export function foo() {}");
  });

  it("inserts ABOVE decorators, not between them and the symbol", async () => {
    const decorated = "@Component\nexport class Widget {}\n"; // Widget on line 2
    const { base, written } = deps({ extract: async () => [] }, { "x.ts": decorated });
    const r = await applyBlockEdits(
      create({ blockSymbolName: "Widget", declLine: 2 }),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.ok).toBe(true);
    const out = written["x.ts"]!.split("\n");
    expect(out[0]).toBe("/**"); // block is first
    expect(out.indexOf("@Component")).toBeGreaterThan(out.indexOf(" * @end")); // decorator is below the block
  });

  it("refuses creating on a symbol that already has a block", async () => {
    const { base } = deps(); // default extract returns a block for "doThing"
    const r = await applyBlockEdits(
      create({ blockSymbolName: "doThing" }),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("already-annotated");
  });

  it("refuses a create whose declLine no longer holds the symbol (stale)", async () => {
    const moved = "// a\n// b\n// c\nexport function foo() {}\n"; // foo is on line 4
    const { base, written } = deps({ extract: async () => [] }, { "x.ts": moved });
    const r = await applyBlockEdits(
      create({ blockSymbolName: "foo", declLine: 1 }),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("decl-mismatch");
    expect(written["x.ts"]).toBeUndefined();
  });

  it("refuses an unsupported language (Python docstrings deferred)", async () => {
    const { base } = deps({ extract: async () => [] }, { "x.py": "def foo(): pass\n" });
    const r = await applyBlockEdits(
      create({ sourcePath: "x.py" }),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("unsupported-format");
  });

  it("dry-run previews the create without writing", async () => {
    const { base, written } = deps({ extract: async () => [] }, { "x.ts": NO_BLOCK });
    const r = await applyBlockEdits(create(), { repoRoot: "/repo", deps: base, dryRun: true });
    expect(r.outcomes[0]!.status).toBe("applied");
    expect(r.outcomes[0]!.detail).toMatch(/would insert/);
    expect(written["x.ts"]).toBeUndefined();
  });
});

describe("applyBlockEdits — dirty guard, dry-run, EOL, idempotency", () => {
  it("refuses a dirty file without --force; applies with --force", async () => {
    const dirty = deps({ isDirty: async () => true });
    const r1 = await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "x" } })]),
      { repoRoot: "/repo", deps: dirty.base },
    );
    expect(r1.outcomes[0]!.status).toBe("dirty");
    expect(dirty.written["x.ts"]).toBeUndefined();

    const forced = deps({ isDirty: async () => true });
    const r2 = await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "x" } })]),
      { repoRoot: "/repo", deps: forced.base, force: true },
    );
    expect(r2.ok).toBe(true);
    expect(forced.written["x.ts"]).toBeDefined();
  });

  it("dry-run previews without writing", async () => {
    const { base, written } = deps();
    const r = await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "engine" } })]),
      { repoRoot: "/repo", deps: base, dryRun: true },
    );
    expect(r.outcomes[0]!.preview).toMatchObject({ line: 4, after: " * role: engine" });
    expect(written["x.ts"]).toBeUndefined();
    expect(r.filesWritten).toEqual([]);
  });

  it("preserves CRLF line endings", async () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const { base, written } = deps({}, { "x.ts": crlf });
    await applyBlockEdits(
      patch([edit({ edit: { field: "role", op: "set", value: "engine" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(written["x.ts"]).toContain("\r\n");
    expect(written["x.ts"]).not.toMatch(/[^\r]\n/);
  });

  it("is idempotent: re-applying after the block changed is stale-refused", async () => {
    // Simulate the post-apply world: the block now has the new role, so its
    // hash differs from the patch's pre-edit hash.
    const { base } = deps({ hash: () => "h2" });
    const r = await applyBlockEdits(
      patch([edit({ blockContentHash: "h1", edit: { field: "role", op: "set", value: "engine" } })]),
      { repoRoot: "/repo", deps: base },
    );
    expect(r.outcomes[0]!.status).toBe("stale");
  });
});
