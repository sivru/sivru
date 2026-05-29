// Pure-helper tests for BlockTriageInbox (DESIGN-0021 slot 1). Row rendering +
// hover actions are covered by the PR's manual browser verification (no
// @testing-library/react dep, per CLAUDE.md).

import { describe, expect, it } from "vitest";

import { cliForDiagnostic, groupDiagnostics } from "./BlockTriageInbox";
import type { BlockDiagnostic } from "../api";

function d(code: string, severity: "error" | "warning", file = "src/a.ts"): BlockDiagnostic {
  return {
    code,
    severity,
    message: `${code} message`,
    location: { filePath: file, startLine: 1, endLine: 5 },
  };
}

describe("groupDiagnostics", () => {
  it("groups by code and orders error groups before warning groups", () => {
    const groups = groupDiagnostics([
      d("SIVRU-E234", "warning"),
      d("SIVRU-E220", "error"),
      d("SIVRU-E234", "warning"),
    ]);
    expect(groups.map((g) => g.code)).toEqual(["SIVRU-E220", "SIVRU-E234"]);
    const e234 = groups.find((g) => g.code === "SIVRU-E234")!;
    expect(e234.diagnostics).toHaveLength(2);
    expect(e234.severity).toBe("warning");
  });

  it("returns no groups for an empty list", () => {
    expect(groupDiagnostics([])).toEqual([]);
  });
});

describe("cliForDiagnostic", () => {
  it("maps each code range to the DESIGN-0021 Copy-CLI command", () => {
    const f = "src/svc.ts";
    expect(cliForDiagnostic("SIVRU-E230", f)).toBe(`sivru block validate ${f}`);
    expect(cliForDiagnostic("SIVRU-E232", f)).toBe(`sivru block validate ${f}`);
    expect(cliForDiagnostic("SIVRU-E233", f)).toBe("sivru block staleness --since=origin/main");
    expect(cliForDiagnostic("SIVRU-E234", f)).toBe(`sivru block graph --check ${f}`);
    expect(cliForDiagnostic("SIVRU-E235", f)).toBe(`sivru block graph --check --strict ${f}`);
    expect(cliForDiagnostic("SIVRU-E236", f)).toBe(`sivru block graph --check ${f}`);
    expect(cliForDiagnostic("SIVRU-E237", f)).toBe(`sivru block validate --autofix ${f}`);
    expect(cliForDiagnostic("SIVRU-E238", f)).toBe(`sivru block validate --autofix ${f}`);
    expect(cliForDiagnostic("SIVRU-E221", f)).toBe(`sivru block check ${f}`);
  });

  it("omits the file arg when there is no location", () => {
    expect(cliForDiagnostic("SIVRU-E234", "")).toBe("sivru block graph --check");
  });
});
