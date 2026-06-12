import { describe, expect, it } from "vitest";

import { FeedbackPatchError, parsePatch } from "./patch.js";

const ok = {
  schema: 1,
  repoRoot: "/r",
  head: "abc",
  edits: [
    { targetNodeId: "n", sourcePath: "x.ts", blockSymbolName: "f", blockContentHash: "h", edit: { field: "role", op: "set", value: "x" } },
  ],
};

describe("parsePatch", () => {
  it("accepts a well-formed patch", () => {
    expect(parsePatch(JSON.stringify(ok)).edits).toHaveLength(1);
  });

  it("rejects non-JSON and a non-object", () => {
    expect(() => parsePatch("{ not json")).toThrow(FeedbackPatchError);
    expect(() => parsePatch("42")).toThrow(FeedbackPatchError);
  });

  it("rejects an unsupported schema", () => {
    expect(() => parsePatch(JSON.stringify({ ...ok, schema: 2 }))).toThrow(/schema/);
  });

  it("rejects an edit missing a required field", () => {
    const bad = { ...ok, edits: [{ ...ok.edits[0], blockContentHash: "" }] };
    expect(() => parsePatch(JSON.stringify(bad))).toThrow(/blockContentHash/);
  });

  it("rejects an unsupported field / wrong value type", () => {
    expect(() => parsePatch(JSON.stringify({ ...ok, edits: [{ ...ok.edits[0], edit: { field: "schema", op: "set", value: "x" } }] }))).toThrow(/field/);
    expect(() => parsePatch(JSON.stringify({ ...ok, edits: [{ ...ok.edits[0], edit: { field: "collaborators", op: "set", value: "notarray" } }] }))).toThrow(/collaborators/);
  });

  it("validates narrative and notes shapes (clean error, not a writer crash)", () => {
    expect(() => parsePatch(JSON.stringify({ ...ok, narrative: [{}] }))).toThrow(/narrative/);
    expect(() => parsePatch(JSON.stringify({ ...ok, notes: [{ note: "x" }] }))).toThrow(/note/);
    // well-formed narrative/notes pass
    expect(() => parsePatch(JSON.stringify({ ...ok, narrative: [{ value: "n" }], notes: [{ targetNodeId: "t", note: "x" }] }))).not.toThrow();
  });
});
