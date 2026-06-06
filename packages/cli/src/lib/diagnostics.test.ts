import { describe, expect, it } from "vitest";
import type { BlockDiagnostic } from "@sivru/search";

import { formatDiagnostic } from "./diagnostics.js";

const withLoc: BlockDiagnostic = {
  code: "SIVRU-E217",
  severity: "error",
  message: "missing-required: `role` is required",
  location: { filePath: "src/foo.ts", startLine: 12, endLine: 20 },
};

const noLoc: BlockDiagnostic = {
  code: "SIVRU-E234",
  severity: "warning",
  message: "collaborator-asymmetric: A -> B",
};

describe("formatDiagnostic", () => {
  it("path-prefixed style leads with file:line for the multi-file block listing", () => {
    expect(formatDiagnostic(withLoc, "path-prefixed")).toBe(
      "src/foo.ts:12: error SIVRU-E217: missing-required: `role` is required",
    );
  });

  it("code-first style leads with the code and trails (line N) for explain", () => {
    expect(formatDiagnostic(withLoc, "code-first")).toBe(
      "SIVRU-E217 [error] missing-required: `role` is required  (line 12)",
    );
  });

  it("path-prefixed style renders <unknown> when there is no location", () => {
    expect(formatDiagnostic(noLoc, "path-prefixed")).toBe(
      "<unknown>: warning SIVRU-E234: collaborator-asymmetric: A -> B",
    );
  });

  it("code-first style omits the (line N) suffix when there is no location", () => {
    expect(formatDiagnostic(noLoc, "code-first")).toBe(
      "SIVRU-E234 [warning] collaborator-asymmetric: A -> B",
    );
  });
});
