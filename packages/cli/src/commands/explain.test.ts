import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseExplainArgs, runExplain } from "./explain.js";

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

describe("parseExplainArgs", () => {
  it("captures the target and defaults", () => {
    const out = parseExplainArgs(["src/foo.ts"]);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.args.target).toBe("src/foo.ts");
    expect(out.args.sinceDays).toBe(90);
    expect(out.args.depth).toBe(1);
    expect(out.args.diff).toBe(false);
    expect(out.args.json).toBe(false);
  });

  it("parses --json, --since, --depth", () => {
    const out = parseExplainArgs([
      "src/foo.ts",
      "--json",
      "--since=30",
      "--depth=1",
    ]);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.args.json).toBe(true);
    expect(out.args.sinceDays).toBe(30);
    expect(out.args.depth).toBe(1);
  });

  it("rejects --depth=2 in v0.5", () => {
    const out = parseExplainArgs(["src/foo.ts", "--depth=2"]);
    expect(out.kind).toBe("err");
  });

  it("rejects missing path", () => {
    const out = parseExplainArgs([]);
    expect(out.kind).toBe("err");
  });

  it("rejects unknown flags", () => {
    const out = parseExplainArgs(["src/foo.ts", "--what"]);
    expect(out.kind).toBe("err");
  });

  it("supports --repo=<dir> shorthand and long form", () => {
    const a = parseExplainArgs(["src/foo.ts", "--repo=/tmp/x"]);
    const b = parseExplainArgs(["src/foo.ts", "--repo", "/tmp/x"]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind === "ok") expect(a.args.repoRoot).toBe("/tmp/x");
    if (b.kind === "ok") expect(b.args.repoRoot).toBe("/tmp/x");
  });
});

describe("runExplain (smoke)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sivru-explain-cli-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function write(p: string, content: string): Promise<void> {
    const abs = join(repo, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  function gitInit(): void {
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "config", "user.name", "t"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"], {
      stdio: "ignore",
    });
  }

  it("emits the artifact JSON on --json", async () => {
    gitInit();
    await write("src/foo.ts", "export function foo() { return 1; }\n");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "c1"], {
      stdio: "ignore",
    });

    const cap = captureIO();
    let exit: number;
    try {
      exit = await runExplain(["src/foo.ts", "--repo", repo, "--json"]);
    } finally {
      cap.restore();
    }
    expect(exit).toBe(0);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.path).toBe("src/foo.ts");
    expect(parsed.public_api.map((e: { name: string }) => e.name)).toContain(
      "foo",
    );
    expect(typeof parsed.footer).toBe("string");
  });

  it("renders markdown by default", async () => {
    gitInit();
    await write("src/foo.ts", "export function foo() { return 1; }\n");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "c1"], {
      stdio: "ignore",
    });
    const cap = captureIO();
    let exit: number;
    try {
      exit = await runExplain(["src/foo.ts", "--repo", repo]);
    } finally {
      cap.restore();
    }
    expect(exit).toBe(0);
    expect(cap.stdout).toMatch(/^explain\s+src\/foo\.ts/);
    expect(cap.stdout).toMatch(/PUBLIC API/);
    expect(cap.stdout).toMatch(/CALLERS/);
    expect(cap.stdout).toMatch(/FOOTER/);
  });

  it("returns 1 for a path outside the repo (SIVRU-E2001)", async () => {
    const cap = captureIO();
    let exit: number;
    try {
      exit = await runExplain(["../escape.ts", "--repo", repo]);
    } finally {
      cap.restore();
    }
    expect(exit).toBe(1);
    expect(cap.stderr).toMatch(/SIVRU-E2001/);
  });

  it("--diff emits diff_mode + removed_symbols for an edit removing an export", async () => {
    gitInit();
    await write("src/foo.ts", [
      "export function alpha() { return 1; }",
      "export function beta() { return 2; }",
    ].join("\n"));
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "c1"], {
      stdio: "ignore",
    });
    // Working-tree edit: drop alpha.
    await write("src/foo.ts", "export function beta() { return 2; }\n");

    const cap = captureIO();
    let exit: number;
    try {
      exit = await runExplain([
        "src/foo.ts",
        "--repo",
        repo,
        "--diff",
        "--json",
      ]);
    } finally {
      cap.restore();
    }
    expect(exit).toBe(0);
    const parsed = JSON.parse(cap.stdout) as {
      diff_mode?: boolean;
      removed_symbols?: Array<{ symbol: string; callers: unknown[] }>;
    };
    expect(parsed.diff_mode).toBe(true);
    expect(parsed.removed_symbols?.map((r) => r.symbol)).toEqual(["alpha"]);
  });
});
