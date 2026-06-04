import { describe, expect, it } from "vitest";

import { runCompletion, generateZsh, generateBash, generateFish, SIVRU_SPEC } from "./completion.js";
import type { Command } from "./index.js";

type Captured = { stdout: string; stderr: string; restore: () => void };

function captureIO(): Captured {
  const captured: Captured = { stdout: "", stderr: "", restore: () => {} };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: typeof origOut }).write = (chunk: unknown): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  (process.stderr as unknown as { write: typeof origErr }).write = (chunk: unknown): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  };
  return captured;
}

describe("SIVRU_SPEC completeness", () => {
  it("covers every Command union member", () => {
    const expected: Command[] = [
      "search",
      "index",
      "mcp",
      "from-git",
      "session",
      "observe",
      "doctor",
      "bench",
      "config",
      "skill",
      "explain",
      "block",
      "checkup",
      "version",
      "completion",
      "help",
    ];
    const actual = SIVRU_SPEC.commands.map((c) => c.name);
    for (const cmd of expected) {
      expect(actual).toContain(cmd);
    }
  });

  it("has no duplicate command names", () => {
    const names = SIVRU_SPEC.commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has no duplicate subcommand names within a command", () => {
    for (const cmd of SIVRU_SPEC.commands) {
      if (!cmd.subcommands) continue;
      const names = cmd.subcommands.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("generateZsh", () => {
  it("produces a valid zsh compdef header", () => {
    const script = generateZsh(SIVRU_SPEC);
    expect(script).toContain("#compdef sivru");
    expect(script).toContain("_sivru()");
    expect(script).toContain("compdef _sivru sivru");
  });

  it("includes every top-level command", () => {
    const script = generateZsh(SIVRU_SPEC);
    for (const cmd of SIVRU_SPEC.commands) {
      expect(script).toContain(cmd.name);
    }
  });

  it("includes subcommands for session, observe, bench, config, skill, block", () => {
    const script = generateZsh(SIVRU_SPEC);
    expect(script).toContain("local -a session_cmds");
    expect(script).toContain("local -a observe_cmds");
    expect(script).toContain("local -a bench_cmds");
    expect(script).toContain("local -a config_cmds");
    expect(script).toContain("local -a skill_cmds");
    expect(script).toContain("local -a block_cmds");
  });

  it("includes search-specific options", () => {
    const script = generateZsh(SIVRU_SPEC);
    expect(script).toContain("--top");
    expect(script).toContain("--bm25");
    expect(script).toContain("--hybrid");
    expect(script).toContain("--embed");
    expect(script).toContain("--rerank");
  });

  it("includes observe server flags alongside subcommands", () => {
    const script = generateZsh(SIVRU_SPEC);
    expect(script).toContain("--port");
    expect(script).toContain("--host");
    expect(script).toContain("--no-ui");
    expect(script).toContain("--writable");
    expect(script).toContain("--log-json");
  });

  it("includes block subcommands and their flags", () => {
    const script = generateZsh(SIVRU_SPEC);
    expect(script).toContain("check-enforcement");
    expect(script).toContain("staleness");
    expect(script).toContain("graph");
    expect(script).toContain("init");
    expect(script).toContain("check-bridges");
    expect(script).toContain("--autofix");
    expect(script).toContain("--allow-dirty");
    expect(script).toContain("--strict");
  });
});

describe("generateBash", () => {
  it("produces a valid bash completion function", () => {
    const script = generateBash(SIVRU_SPEC);
    expect(script).toContain("_sivru_completions()");
    expect(script).toContain("complete -F _sivru_completions sivru");
  });

  it("includes every top-level command", () => {
    const script = generateBash(SIVRU_SPEC);
    for (const cmd of SIVRU_SPEC.commands) {
      expect(script).toContain(cmd.name);
    }
  });

  it("includes observe server flags in the top-level word list", () => {
    const script = generateBash(SIVRU_SPEC);
    expect(script).toContain("--port");
    expect(script).toContain("--host");
    expect(script).toContain("--no-ui");
    expect(script).toContain("--writable");
    expect(script).toContain("--log-json");
  });

  it("includes block subcommands and their flags", () => {
    const script = generateBash(SIVRU_SPEC);
    expect(script).toContain("check-enforcement");
    expect(script).toContain("--autofix");
    expect(script).toContain("--allow-dirty");
    expect(script).toContain("--strict");
  });
});

describe("generateFish", () => {
  it("produces a valid fish completion header", () => {
    const script = generateFish(SIVRU_SPEC);
    expect(script).toContain("complete -c sivru -f");
  });

  it("includes every top-level command", () => {
    const script = generateFish(SIVRU_SPEC);
    for (const cmd of SIVRU_SPEC.commands) {
      expect(script).toContain(`-a ${cmd.name}`);
    }
  });

  it("includes observe server flags", () => {
    const script = generateFish(SIVRU_SPEC);
    expect(script).toContain("-l port");
    expect(script).toContain("-l host");
    expect(script).toContain("-l no-ui");
    expect(script).toContain("-l writable");
    expect(script).toContain("-l log-json");
  });

  it("includes block subcommands and their flags", () => {
    const script = generateFish(SIVRU_SPEC);
    expect(script).toContain("-a check-enforcement");
    expect(script).toContain("-l autofix");
    expect(script).toContain("-l allow-dirty");
    expect(script).toContain("-l strict");
  });
});

describe("runCompletion", () => {
  it("outputs zsh autocomplete script when 'zsh' is passed", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runCompletion(["completion", "zsh"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toContain("#compdef sivru");
    expect(cap.stdout).toContain("_sivru(");
    expect(cap.stdout).toContain("compdef _sivru sivru");
  });

  it("outputs bash autocomplete script when 'bash' is passed", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runCompletion(["completion", "bash"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toContain("_sivru_completions()");
    expect(cap.stdout).toContain("complete -F _sivru_completions sivru");
  });

  it("outputs fish autocomplete script when 'fish' is passed", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runCompletion(["completion", "fish"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toContain("complete -c sivru -f");
    expect(cap.stdout).toContain("complete -c sivru -n");
  });

  it("fails with code 2 and usage instructions when no shell argument is provided", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runCompletion(["completion"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.stderr).toContain("sivru completion: missing shell argument");
    expect(cap.stderr).toContain("Available: bash, zsh, fish");
  });

  it("fails with code 2 and error message when an invalid shell is provided", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runCompletion(["completion", "powershell"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.stderr).toContain('sivru completion: unknown shell "powershell"');
    expect(cap.stderr).toContain("Available: bash, zsh, fish");
  });

  it("is case-insensitive for shell names", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runCompletion(["completion", "ZSH"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toContain("#compdef sivru");
  });
});
