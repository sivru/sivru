import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseExplainArgs,
  renderArtifactMarkdown,
  renderAuthoredSection,
  renderBlocksHealth,
  runExplain,
} from "./explain.js";
import type {
  ExplainArtifact,
  SivruBlockJSON,
  BlockDiagnostic,
} from "@sivru/search";

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

  it("accepts --project with no <path> (DESIGN-0018)", () => {
    const out = parseExplainArgs(["--project"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.args.project).toBe(true);
      expect(out.args.target).toBe("");
    }
  });

  it("rejects --project combined with a <path>", () => {
    const out = parseExplainArgs(["--project", "src/foo.ts"]);
    expect(out.kind).toBe("err");
  });

  it("--project honors --repo", () => {
    const out = parseExplainArgs(["--project", "--repo=/tmp/x"]);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.args.project).toBe(true);
  });

  it("supports --repo=<dir> shorthand and long form", () => {
    const a = parseExplainArgs(["src/foo.ts", "--repo=/tmp/x"]);
    const b = parseExplainArgs(["src/foo.ts", "--repo", "/tmp/x"]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind === "ok") expect(a.args.repoRoot).toBe(resolve("/tmp/x"));
    if (b.kind === "ok") expect(b.args.repoRoot).toBe(resolve("/tmp/x"));
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

// ---------------------------------------------------------------------------
// DESIGN-0017 — authored-context surfacing + block health rendering.
// Pure render helpers over ExplainArtifact, so unit-testable directly.
// ---------------------------------------------------------------------------

function baseArtifact(over: Partial<ExplainArtifact> = {}): ExplainArtifact {
  return {
    path: "src/foo.ts",
    public_api: [],
    callers: [],
    callees: [],
    churn: { commitCount: 0, lastCommitAt: null, sinceDays: 90 },
    ownership: [],
    tests: [],
    authored: [],
    blocks_health: [],
    callers_truncated: null,
    callees_truncated: null,
    callers_skipped_reason: null,
    footer: "scope footer",
    ...over,
  };
}

function fullBlock(over: Partial<SivruBlockJSON> = {}): SivruBlockJSON {
  return {
    schema: 1,
    role: "widget-maker",
    responsibility: "make widgets from sprockets",
    maturity: "stable",
    collaborators: ["sprocketFactory", "widgetCache"],
    invariants: ["widgets are immutable once made"],
    invariantsV2: [
      { rule: "widgets are immutable once made", enforcedBy: "widget.test.ts" },
    ],
    decisions: [
      {
        chose: "an in-memory cache over a disk cache",
        because: "widgets are cheap to recompute",
        validWhile: "the working set fits in memory",
        revisitIf: "a user reports OOM under load",
      },
    ],
    ...over,
  };
}

describe("renderAuthoredSection (DESIGN-0017 §1)", () => {
  it("renders a full symbol block: role, responsibility, invariants, decisions, maturity, collaborators", () => {
    const art = baseArtifact({
      authored: [
        { symbol: "makeWidget", kind: "symbol", block: fullBlock() },
      ],
    });
    const out = renderAuthoredSection(art).join("\n");
    expect(out).toContain("AUTHORED CONTEXT");
    expect(out).toContain("makeWidget  [stable]");
    expect(out).toContain("role: widget-maker");
    expect(out).toContain("responsibility: make widgets from sprockets");
    expect(out).toContain("invariants:");
    expect(out).toContain(
      "- widgets are immutable once made  (enforced-by: widget.test.ts)",
    );
    expect(out).toContain("decisions:");
    expect(out).toContain("- chose: an in-memory cache over a disk cache");
    expect(out).toContain("because: widgets are cheap to recompute");
    expect(out).toContain("valid-while: the working set fits in memory");
    expect(out).toContain("revisit-if: a user reports OOM under load");
    expect(out).toContain(
      "collaborators: sprocketFactory, widgetCache",
    );
  });

  it("labels a module-kind block as (module)", () => {
    const art = baseArtifact({
      authored: [{ kind: "module", block: fullBlock({ maturity: null }) }],
    });
    const out = renderAuthoredSection(art).join("\n");
    expect(out).toContain("(module)");
    // maturity null → no bracket suffix on the header line.
    expect(out).not.toContain("(module)  [");
  });

  it("omits empty optional groups without crashing", () => {
    const art = baseArtifact({
      authored: [
        {
          symbol: "bare",
          kind: "symbol",
          block: fullBlock({
            maturity: null,
            collaborators: [],
            invariants: [],
            invariantsV2: [],
            decisions: [],
          }),
        },
      ],
    });
    const out = renderAuthoredSection(art).join("\n");
    expect(out).toContain("bare");
    expect(out).toContain("role: widget-maker");
    expect(out).not.toContain("invariants:");
    expect(out).not.toContain("decisions:");
    expect(out).not.toContain("collaborators:");
  });

  it("omits the revisit-if line when revisitIf is null", () => {
    const art = baseArtifact({
      authored: [
        {
          symbol: "x",
          kind: "symbol",
          block: fullBlock({
            decisions: [
              {
                chose: "A",
                because: "B",
                validWhile: "C",
                revisitIf: null,
              },
            ],
          }),
        },
      ],
    });
    const out = renderAuthoredSection(art).join("\n");
    expect(out).toContain("valid-while: C");
    expect(out).not.toContain("revisit-if:");
  });

  it("shows the no-blocks line when there is no authored context", () => {
    const out = renderAuthoredSection(baseArtifact()).join("\n");
    expect(out).toContain("AUTHORED CONTEXT");
    expect(out).toContain("(no @sivru blocks attached)");
  });
});

describe("renderBlocksHealth (DESIGN-0017 §2)", () => {
  const errDiag: BlockDiagnostic = {
    code: "SIVRU-E217",
    severity: "error",
    message: "missing-required: `role` is required",
    location: { filePath: "src/foo.ts", startLine: 12, endLine: 20 },
  };

  it("lists diagnostics and points to the diff-scoped drift commands", () => {
    const art = baseArtifact({ blocks_health: [errDiag] });
    const out = renderBlocksHealth(art).join("\n");
    expect(out).toContain("BLOCKS HEALTH");
    expect(out).toContain("1 error(s), 0 warning(s)");
    expect(out).toContain(
      "- SIVRU-E217 [error] missing-required: `role` is required  (line 12)",
    );
    expect(out).toContain("sivru block staleness");
    expect(out).toContain("sivru block graph");
  });

  it("surfaces a broken block even when authored context is empty", () => {
    // An invalid block (block === null) contributes a diagnostic but no
    // authored entry — the section must still render so it does not vanish.
    const art = baseArtifact({ authored: [], blocks_health: [errDiag] });
    const out = renderBlocksHealth(art).join("\n");
    expect(out).toContain("BLOCKS HEALTH");
    expect(out).toContain("SIVRU-E217");
  });

  it("shows a clean note when blocks exist with no diagnostics", () => {
    const art = baseArtifact({
      authored: [{ symbol: "ok", kind: "symbol", block: fullBlock() }],
    });
    const out = renderBlocksHealth(art).join("\n");
    expect(out).toContain("BLOCKS HEALTH");
    expect(out).toContain("(clean — 1 block, no issues)");
  });

  it("stays silent for a blockless file (section omitted)", () => {
    expect(renderBlocksHealth(baseArtifact())).toEqual([]);
  });

  it("is wired into the full markdown render", () => {
    const art = baseArtifact({
      authored: [{ symbol: "makeWidget", kind: "symbol", block: fullBlock() }],
    });
    const md = renderArtifactMarkdown(art);
    // Authored context renders before the derived PUBLIC API section.
    expect(md.indexOf("AUTHORED CONTEXT")).toBeLessThan(md.indexOf("PUBLIC API"));
    expect(md).toContain("BLOCKS HEALTH");
  });

  it("caps the rendered diagnostic list so health never buries the derived facts", () => {
    // 25 diagnostics > the 20-line render cap.
    const many: BlockDiagnostic[] = Array.from({ length: 25 }, (_, i) => ({
      code: "SIVRU-E217",
      severity: "warning" as const,
      message: `issue ${i}`,
      location: { filePath: "src/foo.ts", startLine: i + 1, endLine: i + 1 },
    }));
    const out = renderBlocksHealth(baseArtifact({ blocks_health: many }));
    const diagLines = out.filter((l) => l.trimStart().startsWith("- SIVRU-"));
    expect(diagLines).toHaveLength(20);
    expect(out.join("\n")).toContain("... 5 more");
    // The count summary still reflects the FULL set, not the capped render.
    expect(out.join("\n")).toContain("0 error(s), 25 warning(s)");
  });
});
