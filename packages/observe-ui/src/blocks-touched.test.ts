import { describe, expect, it } from "vitest";

import { blocksTouched, editedFilePaths, samePath } from "./blocks-touched";
import type { BlockNodeDetail } from "./api";
import type { SivruEvent } from "./types";

function toolUse(tool: string, file: string, index: number): SivruEvent {
  return {
    kind: "tool_use",
    sessionId: "s",
    index,
    tool,
    input: { file_path: file },
    raw: {},
  };
}

function node(filePath: string, name: string): BlockNodeDetail {
  return {
    name,
    filePath,
    kind: "symbol",
    range: { filePath, startLine: 1, endLine: 5 },
    collaborators: [],
    block: null,
    diagnostics: [],
  };
}

describe("editedFilePaths", () => {
  it("collects file_path from Edit/Write/MultiEdit tool_use events", () => {
    const events: SivruEvent[] = [
      toolUse("Edit", "/repo/src/a.ts", 0),
      toolUse("Write", "/repo/src/b.ts", 1),
      toolUse("Read", "/repo/src/c.ts", 2), // not an edit tool
      { kind: "user_message", sessionId: "s", index: 3, raw: {} },
      toolUse("Edit", "/repo/src/a.ts", 4), // dup collapses
    ];
    expect(editedFilePaths(events).sort()).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
  });

  it("ignores tool_use without a file_path input", () => {
    const ev: SivruEvent = { kind: "tool_use", sessionId: "s", index: 0, tool: "Edit", input: {}, raw: {} };
    expect(editedFilePaths([ev])).toEqual([]);
  });
});

describe("samePath", () => {
  it("matches identical and abs/rel suffix pairs at path boundaries", () => {
    expect(samePath("/repo/src/a.ts", "/repo/src/a.ts")).toBe(true);
    expect(samePath("/repo/src/a.ts", "src/a.ts")).toBe(true);
    expect(samePath("src/a.ts", "/repo/src/a.ts")).toBe(true);
    expect(samePath("/repo/src/a.ts", "/repo/src/ba.ts")).toBe(false);
  });

  it("does not collide bare basenames across directories", () => {
    // A bare basename must match exactly — two different dirs sharing a
    // filename are not the same file.
    expect(samePath("a.ts", "/repo/src/a.ts")).toBe(false);
    expect(samePath("a.ts", "a.ts")).toBe(true);
  });
});

describe("blocksTouched", () => {
  it("returns nodes whose file was edited", () => {
    const nodes = [node("/repo/src/a.ts", "A"), node("/repo/src/b.ts", "B")];
    const touched = blocksTouched(nodes, ["src/a.ts"]);
    expect(touched.map((n) => n.name)).toEqual(["A"]);
  });
});
