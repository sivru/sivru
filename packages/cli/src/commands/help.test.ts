import { describe, expect, it } from "vitest";

import { runHelp } from "./help.js";

type Captured = { stdout: string; restore: () => void };

function captureStdout(): Captured {
  const captured: Captured = { stdout: "", restore: () => {} };
  const origOut = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
  };
  return captured;
}

describe("runHelp", () => {
  it("lists the skill subcommand and its options", async () => {
    const cap = captureStdout();
    let code: number;
    try {
      code = await runHelp(["help"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/skill install\|uninstall/);
    expect(cap.stdout).toMatch(/--project/);
  });
});
