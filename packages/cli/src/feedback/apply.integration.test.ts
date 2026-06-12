// Integration: apply a patch to a REAL source file with the REAL block
// machinery (extractBlocks + hashBlockContent) — no injected extract/hash. The
// round-trip that proves the loop closes: build a patch from the real block
// hash, apply, re-extract, see the field changed and the rest untouched.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractBlocks, hashBlockContent } from "@sivru/search";

import { applyBlockEdits } from "./apply.js";
import type { FeedbackPatch } from "./patch.js";

const FILE = `/**
 * @sivru
 * schema: 1
 * role: worker
 * responsibility: do the thing
 * collaborators: [helper, parse]
 * maturity: stable
 * @end
 */
export function doThing() {}
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sivru-feedback-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function realHash(abs: string): Promise<string> {
  const blocks = await extractBlocks(abs);
  return hashBlockContent(blocks.find((b) => b.symbolName === "doThing")!.block);
}

describe("feedback apply — real round-trip", () => {
  it("applies a structured edit, re-extract shows it, rest untouched", async () => {
    const abs = join(dir, "x.ts");
    writeFileSync(abs, FILE);
    const hash = await realHash(abs);

    const patch: FeedbackPatch = {
      schema: 1,
      repoRoot: dir,
      head: "test",
      edits: [
        {
          targetNodeId: "symbol:x.ts#doThing",
          sourcePath: "x.ts",
          blockSymbolName: "doThing",
          blockContentHash: hash,
          edit: { field: "responsibility", op: "set", value: "do the corrected thing" },
        },
      ],
    };
    // not a git repo → isDirty is clean → applies
    const r = await applyBlockEdits(patch, { repoRoot: dir });
    expect(r.ok).toBe(true);

    const after = readFileSync(abs, "utf8");
    expect(after).toContain("responsibility: do the corrected thing");
    expect(after).not.toContain("responsibility: do the thing");
    // re-extract parses cleanly and reflects the change
    const reblocks = await extractBlocks(abs);
    const blk = reblocks.find((b) => b.symbolName === "doThing")!.block as { responsibility: string };
    expect(blk.responsibility).toBe("do the corrected thing");
    // surrounding code untouched
    expect(after).toContain("export function doThing() {}");
    expect(after.split("\n").length).toBe(FILE.split("\n").length);
  });

  it("CREATES a real, re-parseable block on an un-annotated symbol", async () => {
    const abs = join(dir, "w.ts");
    writeFileSync(abs, "export function widget() {}\n");
    const patch: FeedbackPatch = {
      schema: 1,
      repoRoot: dir,
      head: "test",
      edits: [],
      creates: [{
        targetNodeId: "symbol:w.ts#widget", sourcePath: "w.ts", blockSymbolName: "widget",
        declLine: 1, role: "ui-widget", responsibility: "render the widget",
      }],
    };
    const r = await applyBlockEdits(patch, { repoRoot: dir });
    expect(r.ok).toBe(true);
    // the freshly written block re-extracts and parses with the given fields
    const blocks = await extractBlocks(abs);
    const blk = blocks.find((b) => b.symbolName === "widget")!.block as { role: string; responsibility: string };
    expect(blk.role).toBe("ui-widget");
    expect(blk.responsibility).toBe("render the widget");
    expect(readFileSync(abs, "utf8")).toContain("export function widget() {}");
  });

  it("refuses a stale patch (block edited after export) — no corruption", async () => {
    const abs = join(dir, "x.ts");
    writeFileSync(abs, FILE);
    const staleHash = "deadbeef"; // never matches the real block
    const patch: FeedbackPatch = {
      schema: 1,
      repoRoot: dir,
      head: "test",
      edits: [{
        targetNodeId: "n", sourcePath: "x.ts", blockSymbolName: "doThing",
        blockContentHash: staleHash, edit: { field: "role", op: "set", value: "engine" },
      }],
    };
    const r = await applyBlockEdits(patch, { repoRoot: dir });
    expect(r.ok).toBe(false);
    expect(r.outcomes[0]!.status).toBe("stale");
    expect(readFileSync(abs, "utf8")).toBe(FILE); // byte-identical, untouched
  });
});
