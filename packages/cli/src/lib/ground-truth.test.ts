import { describe, expect, it } from "vitest";
import type { SivruEvent } from "@sivrujs/observe";

import {
  extractGroundTruth,
  isEntityShapedQuery,
  relativizePath,
} from "./ground-truth.js";

const ROOT = "/repo";

function ev(index: number, kind: SivruEvent["kind"], extras: Partial<SivruEvent>): SivruEvent {
  return {
    kind,
    sessionId: "s",
    index,
    raw: {},
    ...extras,
  };
}

describe("relativizePath", () => {
  it("returns relative path when file is inside root", () => {
    expect(relativizePath("/repo/src/auth/login.ts", "/repo")).toBe(
      "src/auth/login.ts",
    );
  });

  it("returns null when file equals the root", () => {
    expect(relativizePath("/repo", "/repo")).toBeNull();
  });

  it("returns null when file is outside the root", () => {
    expect(relativizePath("/elsewhere/file.ts", "/repo")).toBeNull();
  });

  it("handles trailing-separator edge case", () => {
    expect(relativizePath("/repo/", "/repo")).toBeNull();
  });
});

describe("extractGroundTruth", () => {
  it("returns empty when there are no query events", () => {
    expect(extractGroundTruth([], ROOT)).toEqual([]);
    expect(
      extractGroundTruth(
        [ev(0, "tool_use", { tool: "Bash", input: { command: "ls" } })],
        ROOT,
      ),
    ).toEqual([]);
  });

  it("collects file_path arguments from Edit/Write/Read between two queries", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "fix the auth bug" }),
      ev(1, "tool_use", {
        tool: "Read",
        input: { file_path: "/repo/src/auth/login.ts" },
      }),
      ev(2, "tool_use", {
        tool: "Edit",
        input: { file_path: "/repo/src/auth/jwt.ts" },
      }),
      ev(3, "user_message", { text: "now do the same for sessions" }),
      ev(4, "tool_use", {
        tool: "Write",
        input: { file_path: "/repo/src/sessions/store.ts" },
      }),
    ];
    const gt = extractGroundTruth(events, ROOT);
    expect(gt).toHaveLength(2);
    expect(gt[0]?.query).toBe("fix the auth bug");
    expect(gt[0]?.relevantFiles).toEqual([
      "src/auth/login.ts",
      "src/auth/jwt.ts",
    ]);
    expect(gt[1]?.relevantFiles).toEqual(["src/sessions/store.ts"]);
  });

  it("dedupes file paths within a single query window", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "edit the login file repeatedly" }),
      ev(1, "tool_use", {
        tool: "Read",
        input: { file_path: "/repo/login.ts" },
      }),
      ev(2, "tool_use", {
        tool: "Edit",
        input: { file_path: "/repo/login.ts" },
      }),
      ev(3, "tool_use", {
        tool: "Edit",
        input: { file_path: "/repo/login.ts" },
      }),
    ];
    const gt = extractGroundTruth(events, ROOT);
    expect(gt[0]?.relevantFiles).toEqual(["login.ts"]);
  });

  it("ignores file paths outside the project root", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "open the cookbook reference" }),
      ev(1, "tool_use", {
        tool: "Read",
        input: { file_path: "/elsewhere/notes.md" },
      }),
    ];
    expect(extractGroundTruth(events, ROOT)[0]?.relevantFiles).toEqual([]);
  });

  it("ignores tools that don't carry a file_path (Bash, Grep, Glob)", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "find auth code" }),
      ev(1, "tool_use", { tool: "Grep", input: { pattern: "authenticate" } }),
      ev(2, "tool_use", { tool: "Bash", input: { command: "rg -n 'jwt'" } }),
      ev(3, "tool_use", {
        tool: "Read",
        input: { file_path: "/repo/auth.ts" },
      }),
    ];
    expect(extractGroundTruth(events, ROOT)[0]?.relevantFiles).toEqual(["auth.ts"]);
  });

  it("captures sivru.search tool_use queries with source=search_call", () => {
    const events: SivruEvent[] = [
      ev(0, "tool_use", {
        tool: "sivru.search",
        input: { query: "jwt verification" },
      }),
      ev(1, "tool_use", {
        tool: "Edit",
        input: { file_path: "/repo/src/auth/jwt.ts" },
      }),
    ];
    const gt = extractGroundTruth(events, ROOT);
    expect(gt[0]?.source).toBe("search_call");
    expect(gt[0]?.query).toBe("jwt verification");
    expect(gt[0]?.relevantFiles).toEqual(["src/auth/jwt.ts"]);
  });

  it("recognizes sivru.search under various tool-name spellings", () => {
    // search_call queries bypass the MIN_QUERY_CHARS gate (the user
    // explicitly asked for that string to be searched, so we keep it
    // even when short). One record per tool_use.
    for (const tool of ["sivru.search", "sivru_search", "SIVRU__SEARCH"]) {
      const ev0 = ev(0, "tool_use", {
        tool,
        input: { query: "jwt rotation" },
      });
      const out = extractGroundTruth([ev0], ROOT);
      expect(out).toHaveLength(1);
      expect(out[0]?.source).toBe("search_call");
      expect(out[0]?.query).toBe("jwt rotation");
    }
  });

  it("skips empty user_message text and bracket-wrapped system markers", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", { text: "" }),
      ev(1, "user_message", { text: "[Request interrupted by user]" }),
      ev(2, "user_message", { text: "real query about auth handling" }),
    ];
    const gt = extractGroundTruth(events, ROOT);
    expect(gt).toHaveLength(1);
    expect(gt[0]?.query).toMatch(/auth handling/);
  });

  it("trims user_message to first sentence", () => {
    const events: SivruEvent[] = [
      ev(0, "user_message", {
        text: "fix the auth bug. Then update the tests. Also bump version.",
      }),
    ];
    expect(extractGroundTruth(events, ROOT)[0]?.query).toBe(
      "fix the auth bug.",
    );
  });
});

describe("isEntityShapedQuery", () => {
  it("accepts CamelCase identifiers", () => {
    expect(isEntityShapedQuery("how does AuthHandler verify tokens")).toBe(
      true,
    );
    expect(isEntityShapedQuery("getUserById is broken")).toBe(true);
  });

  it("accepts snake_case", () => {
    expect(isEntityShapedQuery("look at auth_token validation")).toBe(true);
  });

  it("accepts dotted notation", () => {
    expect(isEntityShapedQuery("user.email isn't being saved")).toBe(true);
    expect(isEntityShapedQuery("update src/auth/login.ts")).toBe(true);
  });

  it("accepts code-search trigger words", () => {
    expect(isEntityShapedQuery("which function handles jwt")).toBe(true);
    expect(isEntityShapedQuery("we need a new endpoint")).toBe(true);
    expect(isEntityShapedQuery("the error keeps happening")).toBe(true);
  });

  it("rejects vague messages with no entity references", () => {
    expect(isEntityShapedQuery("yes go ahead")).toBe(false);
    expect(isEntityShapedQuery("now do the same thing")).toBe(false);
    expect(isEntityShapedQuery("sounds good")).toBe(false);
  });
});
