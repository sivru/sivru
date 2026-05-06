import { describe, expect, it } from "vitest";

import { parseNodeVersion, runDoctor } from "./doctor.js";

type Captured = { stdout: string; stderr: string; restore: () => void };

function captureIO(): Captured {
  const captured: Captured = { stdout: "", stderr: "", restore: () => {} };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErr;
  };
  return captured;
}

describe("parseNodeVersion", () => {
  it.each([
    ["v22.11.0", { major: 22, minor: 11, patch: 0 }],
    ["22.2.0", { major: 22, minor: 2, patch: 0 }],
    ["v20.10.0", { major: 20, minor: 10, patch: 0 }],
    ["v24.0.0-rc.1", { major: 24, minor: 0, patch: 0 }],
  ])("parses %j", (raw, expected) => {
    expect(parseNodeVersion(raw)).toEqual(expected);
  });

  it("returns null for unparseable input", () => {
    expect(parseNodeVersion("nonsense")).toBeNull();
    expect(parseNodeVersion("")).toBeNull();
  });
});

describe("runDoctor — JSON output", () => {
  it("emits a single-line JSON report and a 0/1 exit code", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runDoctor(["doctor", "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0); // we may have warnings on this CI machine but no fails
    const trimmed = cap.stdout.trim();
    expect(trimmed.includes("\n")).toBe(false);
    const parsed = JSON.parse(trimmed) as {
      version: string;
      checks: Array<{ name: string; severity: string; detail: string }>;
      summary: { ok: number; warn: number; fail: number };
    };
    expect(parsed.version.length).toBeGreaterThan(0);
    expect(parsed.checks.length).toBeGreaterThanOrEqual(9);
    for (const c of parsed.checks) {
      expect(["ok", "warn", "fail"]).toContain(c.severity);
    }
    expect(
      parsed.summary.ok + parsed.summary.warn + parsed.summary.fail,
    ).toBe(parsed.checks.length);
  });
});

describe("runDoctor — text output", () => {
  it("renders the table and exits 0 when no checks failed", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runDoctor(["doctor"]);
    } finally {
      cap.restore();
    }
    expect(code).toBeGreaterThanOrEqual(0);
    expect(code).toBeLessThanOrEqual(1);
    expect(cap.stdout).toMatch(/sivru doctor /);
    expect(cap.stdout).toMatch(/\[(ok|warn|fail)\]/);
    expect(cap.stdout).toMatch(/ok, \d+ warn, \d+ fail/);
  });
});

describe("runDoctor — argv parsing", () => {
  it("rejects unknown flags with exit 2", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runDoctor(["doctor", "--bogus"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/unknown flag/);
  });
});
