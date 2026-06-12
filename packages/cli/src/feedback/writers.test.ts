import { describe, expect, it } from "vitest";

import { applyNarrative } from "./narrative.js";
import { appendNotes } from "./notes.js";

describe("applyNarrative", () => {
  it("writes joined edits to .sivru/explainer.md", async () => {
    let path = "";
    let content = "";
    const r = await applyNarrative(
      [{ value: "A system that does things." }, { value: "It has five modules." }],
      "/repo",
      { write: async (p, c) => { path = p; content = c; } },
    );
    expect(r.written).toBe(true);
    expect(path.replace(/\\/g, "/").endsWith("/.sivru/explainer.md")).toBe(true);
    expect(content).toBe("A system that does things.\n\nIt has five modules.\n");
  });

  it("no-ops with no edits", async () => {
    let wrote = false;
    const r = await applyNarrative([], "/repo", { write: async () => { wrote = true; } });
    expect(r.written).toBe(false);
    expect(wrote).toBe(false);
  });

  it("is idempotent (same edits → identical bytes)", async () => {
    const cap: string[] = [];
    const w = { write: async (_p: string, c: string) => { cap.push(c); } };
    await applyNarrative([{ value: "x" }], "/repo", w);
    await applyNarrative([{ value: "x" }], "/repo", w);
    expect(cap[0]).toBe(cap[1]);
  });
});

describe("appendNotes", () => {
  it("writes a header + the note on first run", async () => {
    let content = "";
    const r = await appendNotes(
      [{ targetNodeId: "symbol:x.ts#f", sourcePath: "x.ts", note: "responsibility is vague" }],
      "/repo",
      { read: async () => "", write: async (_p, c) => { content = c; } },
    );
    expect(r.added).toBe(1);
    expect(content).toContain("# Explainer feedback notes");
    expect(content).toContain("- **symbol:x.ts#f** (`x.ts`): responsibility is vague");
  });

  it("dedupes on re-apply (no double-write)", async () => {
    const note = { targetNodeId: "n", note: "same note" };
    let store = "";
    const deps = { read: async () => store, write: async (_p: string, c: string) => { store = c; } };
    const r1 = await appendNotes([note], "/repo", deps);
    const r2 = await appendNotes([note], "/repo", deps);
    expect(r1.added).toBe(1);
    expect(r2.added).toBe(0); // already present → not appended again
  });

  it("flattens multi-line note text to one line", async () => {
    let content = "";
    await appendNotes(
      [{ targetNodeId: "n", note: "line one\n  line two" }],
      "/repo",
      { read: async () => "", write: async (_p, c) => { content = c; } },
    );
    expect(content).toContain("line one line two");
  });
});
