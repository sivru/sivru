import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyMcpCap,
  effectiveCap,
  loadMcpCapConfig,
  MCP_CAP_DEFAULT,
  MCP_CAP_HARD_CEILING,
} from "./mcp-cap.js";
import { SivruExplainError, type ExplainArtifact } from "./types.js";

function emptyArtifact(): ExplainArtifact {
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
    footer: "",
  };
}

function repeatCaller(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    filePath: `src/c${i}.ts`,
    line: 1,
    symbols: ["x"],
  }));
}

function repeatCallee(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    filePath: `src/d${i}.ts`,
    symbols: ["x"],
  }));
}

describe("effectiveCap", () => {
  it("passes through positive integers below the ceiling", () => {
    expect(effectiveCap(30)).toBe(30);
    expect(effectiveCap(1)).toBe(1);
  });

  it("clamps values above the ceiling to the ceiling", () => {
    expect(effectiveCap(1000)).toBe(MCP_CAP_HARD_CEILING);
  });

  it("treats 0 as 'use the ceiling' (foot-cannon fix #10)", () => {
    expect(effectiveCap(0)).toBe(MCP_CAP_HARD_CEILING);
  });

  it("raises SIVRU-E2008 for negative / non-integer values", () => {
    try {
      effectiveCap(-1);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SivruExplainError);
      expect((e as SivruExplainError).code).toBe("SIVRU-E2008");
    }
    try {
      effectiveCap(3.14);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SivruExplainError).code).toBe("SIVRU-E2008");
    }
  });
});

describe("applyMcpCap", () => {
  it("truncates each list independently and records the dropped counts", () => {
    const art = emptyArtifact();
    art.callers = repeatCaller(45);
    art.callees = repeatCallee(35);
    const out = applyMcpCap(art, MCP_CAP_DEFAULT);
    expect(out.callers).toHaveLength(MCP_CAP_DEFAULT);
    expect(out.callers_truncated).toBe(15);
    expect(out.callees).toHaveLength(MCP_CAP_DEFAULT);
    expect(out.callees_truncated).toBe(5);
  });

  it("does not touch lists already under the cap", () => {
    const art = emptyArtifact();
    art.callers = repeatCaller(5);
    art.callees = repeatCallee(5);
    const out = applyMcpCap(art, MCP_CAP_DEFAULT);
    expect(out.callers).toHaveLength(5);
    expect(out.callers_truncated).toBeNull();
    expect(out.callees).toHaveLength(5);
    expect(out.callees_truncated).toBeNull();
  });

  it("leaves callers=null alone (precision-floor T12 case)", () => {
    const art = emptyArtifact();
    art.callers = null;
    art.callers_skipped_reason = "precision-floor";
    art.callees = repeatCallee(35);
    const out = applyMcpCap(art, 30);
    expect(out.callers).toBeNull();
    expect(out.callers_skipped_reason).toBe("precision-floor");
    expect(out.callees).toHaveLength(30);
  });

  it("does not mutate the source artifact", () => {
    const art = emptyArtifact();
    art.callers = repeatCaller(45);
    applyMcpCap(art, 30);
    expect(art.callers).toHaveLength(45);
  });

  it("preserves authored[].block and blocks_health through the cap (DESIGN-0017 MCP parity)", () => {
    const art = emptyArtifact();
    art.callers = repeatCaller(45); // force the cap path to run
    art.authored = [
      {
        symbol: "makeWidget",
        kind: "symbol",
        block: {
          schema: 1,
          role: "widget-maker",
          responsibility: "make widgets",
          maturity: "stable",
          collaborators: [],
          invariants: [],
          invariantsV2: [],
          decisions: [],
        },
      },
    ];
    art.blocks_health = [
      {
        code: "SIVRU-E217",
        severity: "error",
        message: "missing-required: `role` is required",
      },
    ];
    const out = applyMcpCap(art, 30);
    expect(out.callers).toHaveLength(30); // cap did run
    expect(out.authored[0]?.block?.role).toBe("widget-maker");
    expect(out.blocks_health).toHaveLength(1);
    expect(out.blocks_health[0]?.code).toBe("SIVRU-E217");
  });
});

describe("loadMcpCapConfig", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sivru-explain-cap-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(p: string, content: string): Promise<void> {
    const abs = join(root, p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  it("returns the default when the file is missing", async () => {
    expect(await loadMcpCapConfig(root)).toBe(MCP_CAP_DEFAULT);
  });

  it("reads `mcpCap` from .sivru/explain.json", async () => {
    await write(".sivru/explain.json", JSON.stringify({ mcpCap: 50 }));
    expect(await loadMcpCapConfig(root)).toBe(50);
  });

  it("rejects malformed JSON with SIVRU-E2008", async () => {
    await write(".sivru/explain.json", "{ not json");
    try {
      await loadMcpCapConfig(root);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SivruExplainError).code).toBe("SIVRU-E2008");
    }
  });

  it("rejects non-number mcpCap with SIVRU-E2008", async () => {
    await write(".sivru/explain.json", JSON.stringify({ mcpCap: "thirty" }));
    try {
      await loadMcpCapConfig(root);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SivruExplainError).code).toBe("SIVRU-E2008");
    }
  });

  it("accepts 0 (resolves to ceiling later via effectiveCap)", async () => {
    await write(".sivru/explain.json", JSON.stringify({ mcpCap: 0 }));
    expect(await loadMcpCapConfig(root)).toBe(0);
  });
});
