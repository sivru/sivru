import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _initInternal, _internal } from "./observe.js";

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

type StubCall = { cmd: string; args: readonly string[] };
type StubResult = { code: number; stdout?: string; stderr?: string };

/** Build a spawn stub that returns canned results based on the args[0]/args[1] pair. */
function makeSpawnStub(table: Array<{ match: string; result: StubResult }>): {
  fn: (cmd: string, args: readonly string[]) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fn = async (cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    const argStr = args.join(" ");
    const matched = table.find((row) => argStr.startsWith(row.match));
    const result = matched?.result ?? { code: 127 };
    return {
      code: result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  return { fn, calls };
}

let tmpRoot: string;
let originalSpawn: typeof _initInternal.spawn;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "sivru-observe-init-"));
  originalSpawn = _initInternal.spawn;
});

afterEach(async () => {
  _initInternal.spawn = originalSpawn;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("runObserveInit — happy path", () => {
  it("registers MCP, writes CLAUDE.md, writes subagent file", async () => {
    const stub = makeSpawnStub([
      { match: "--version", result: { code: 0, stdout: "claude 1.0.0" } },
      { match: "mcp list", result: { code: 0, stdout: "no servers" } },
      { match: "mcp add", result: { code: 0, stdout: "added" } },
    ]);
    _initInternal.spawn = stub.fn;

    const cap = captureIO();
    let code: number;
    try {
      code = await _internal.runObserveInit(["init", "--cwd", tmpRoot]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/registered mcp server/);
    expect(cap.stdout).toMatch(/CLAUDE\.md/);
    expect(cap.stdout).toMatch(/wrote .+sivru-search\.md/);

    // Verify the spawn stub saw the expected sequence
    expect(stub.calls.map((c) => c.args.join(" "))).toEqual([
      "--version",
      "mcp list",
      expect.stringContaining("mcp add sivru -s user --"),
    ]);

    // Files actually written
    const claudeMd = await readFile(join(tmpRoot, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("<!-- sivru-hint -->");
    expect(existsSync(join(tmpRoot, ".claude", "agents", "sivru-search.md"))).toBe(true);
  });
});

describe("runObserveInit — idempotency", () => {
  it("doesn't duplicate the CLAUDE.md hint or re-register MCP on second run", async () => {
    const stub = makeSpawnStub([
      { match: "--version", result: { code: 0, stdout: "claude 1.0.0" } },
      // Second run: claude mcp list now contains 'sivru'.
      { match: "mcp list", result: { code: 0, stdout: "sivru: ok" } },
      { match: "mcp add", result: { code: 0, stdout: "added" } },
    ]);
    _initInternal.spawn = stub.fn;

    // First run
    let cap = captureIO();
    try {
      await _internal.runObserveInit(["init", "--cwd", tmpRoot]);
    } finally {
      cap.restore();
    }

    // Second run — should be all "[=]" markers.
    cap = captureIO();
    try {
      await _internal.runObserveInit(["init", "--cwd", tmpRoot]);
    } finally {
      cap.restore();
    }
    expect(cap.stdout).toMatch(/already registered/);
    expect(cap.stdout).toMatch(/already has the sivru hint/);
    expect(cap.stdout).toMatch(/already exists/);

    // CLAUDE.md should have exactly ONE hint block
    const claudeMd = await readFile(join(tmpRoot, "CLAUDE.md"), "utf8");
    const matches = claudeMd.match(/<!-- sivru-hint -->/g);
    expect(matches?.length ?? 0).toBe(1);
  });
});

describe("runObserveInit — claude binary missing", () => {
  it("warns about missing claude but still writes CLAUDE.md + subagent", async () => {
    const stub = makeSpawnStub([
      { match: "--version", result: { code: 127 } }, // claude not on PATH
    ]);
    _initInternal.spawn = stub.fn;

    const cap = captureIO();
    let code: number;
    try {
      code = await _internal.runObserveInit(["init", "--cwd", tmpRoot]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/claude binary not found/);
    expect(existsSync(join(tmpRoot, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tmpRoot, ".claude", "agents", "sivru-search.md"))).toBe(true);
  });
});

describe("runObserveInit — flags", () => {
  it("--dry-run doesn't write any files", async () => {
    const stub = makeSpawnStub([
      { match: "--version", result: { code: 0, stdout: "claude 1.0.0" } },
      { match: "mcp list", result: { code: 0, stdout: "no servers" } },
    ]);
    _initInternal.spawn = stub.fn;

    const cap = captureIO();
    let code: number;
    try {
      code = await _internal.runObserveInit(["init", "--cwd", tmpRoot, "--dry-run"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/dry run/i);
    // mcp add must NOT have been called
    expect(stub.calls.find((c) => c.args.join(" ").startsWith("mcp add"))).toBeUndefined();
    // No files written
    expect(existsSync(join(tmpRoot, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(tmpRoot, ".claude"))).toBe(false);
  });

  it("--skip-mcp doesn't call claude at all", async () => {
    const stub = makeSpawnStub([
      { match: "--version", result: { code: 0 } },
      { match: "mcp list", result: { code: 0 } },
      { match: "mcp add", result: { code: 0 } },
    ]);
    _initInternal.spawn = stub.fn;

    const cap = captureIO();
    try {
      await _internal.runObserveInit(["init", "--cwd", tmpRoot, "--skip-mcp"]);
    } finally {
      cap.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("--skip-claude-md doesn't touch CLAUDE.md", async () => {
    const stub = makeSpawnStub([
      { match: "--version", result: { code: 0 } },
      { match: "mcp list", result: { code: 0, stdout: "sivru: ok" } },
    ]);
    _initInternal.spawn = stub.fn;

    const cap = captureIO();
    try {
      await _internal.runObserveInit(["init", "--cwd", tmpRoot, "--skip-claude-md"]);
    } finally {
      cap.restore();
    }
    expect(existsSync(join(tmpRoot, "CLAUDE.md"))).toBe(false);
  });

  it("--skip-subagent doesn't create .claude/agents/", async () => {
    const stub = makeSpawnStub([
      { match: "--version", result: { code: 0 } },
      { match: "mcp list", result: { code: 0, stdout: "sivru: ok" } },
    ]);
    _initInternal.spawn = stub.fn;

    const cap = captureIO();
    try {
      await _internal.runObserveInit(["init", "--cwd", tmpRoot, "--skip-subagent"]);
    } finally {
      cap.restore();
    }
    expect(existsSync(join(tmpRoot, ".claude"))).toBe(false);
  });

  it("rejects unknown flags with exit 2", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await _internal.runObserveInit(["init", "--bogus"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/unknown flag/);
  });
});

describe("runObserveInit — appends sivru hint to existing CLAUDE.md", () => {
  it("preserves existing content and appends with separator", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tmpRoot, "CLAUDE.md"),
      "# My Project\n\nExisting content.\n",
      "utf8",
    );

    const stub = makeSpawnStub([
      { match: "--version", result: { code: 0 } },
      { match: "mcp list", result: { code: 0, stdout: "sivru: ok" } },
    ]);
    _initInternal.spawn = stub.fn;

    const cap = captureIO();
    try {
      await _internal.runObserveInit(["init", "--cwd", tmpRoot]);
    } finally {
      cap.restore();
    }
    const updated = await readFile(join(tmpRoot, "CLAUDE.md"), "utf8");
    expect(updated).toMatch(/# My Project/);
    expect(updated).toMatch(/Existing content\./);
    expect(updated).toMatch(/<!-- sivru-hint -->/);
  });
});
