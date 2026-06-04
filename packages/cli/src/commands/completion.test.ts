import { describe, expect, it } from "vitest";

import { runCompletion } from "./completion.js";

type Captured = { output: string; restore: () => void };

function captureStdout(): Captured {
  const captured: Captured = { output: "", restore: () => {} };
  const origOut = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.output += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
  };
  return captured;
}

function captureStderr(): Captured {
  const captured: Captured = { output: "", restore: () => {} };
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured.output += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErr;
  };
  return captured;
}

describe("runCompletion", () => {
  it("outputs zsh autocomplete script when 'zsh' is passed", async () => {
    const cap = captureStdout();
    let code: number;
    try {
      code = await runCompletion(["completion", "zsh"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.output).toContain("#compdef sivru");
    expect(cap.output).toContain("_sivru(");
    expect(cap.output).toContain("session_cmds=");
  });

  it("outputs bash autocomplete script when 'bash' is passed", async () => {
    const cap = captureStdout();
    let code: number;
    try {
      code = await runCompletion(["completion", "bash"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.output).toContain("_sivru_completions()");
    expect(cap.output).toContain("complete -F _sivru_completions sivru");
  });

  it("outputs fish autocomplete script when 'fish' is passed", async () => {
    const cap = captureStdout();
    let code: number;
    try {
      code = await runCompletion(["completion", "fish"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.output).toContain("complete -c sivru -f");
    expect(cap.output).toContain("complete -c sivru -n");
  });

  it("fails with code 2 and usage instructions when no shell argument is provided", async () => {
    const cap = captureStderr();
    let code: number;
    try {
      code = await runCompletion(["completion"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.output).toContain("sivru completion: missing shell argument");
    expect(cap.output).toContain("Available: bash, zsh, fish");
  });

  it("fails with code 2 and error message when an invalid shell is provided", async () => {
    const cap = captureStderr();
    let code: number;
    try {
      code = await runCompletion(["completion", "powershell"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.output).toContain('sivru completion: unknown shell "powershell"');
    expect(cap.output).toContain("Available: bash, zsh, fish");
  });
});
