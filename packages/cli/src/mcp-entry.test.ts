import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  _clearIndexCacheForTest,
  _indexBuildCountForTest,
  createMcpServer,
  EXPLAIN_TOOL_DESCRIPTION,
  explainTool,
  FIND_RELATED_TOOL_DESCRIPTION,
  findRelatedTool,
  parseExplainArgs,
  SEARCH_TOOL_DESCRIPTION,
  searchTool,
} from "./mcp-entry.js";
import { execFileSync } from "node:child_process";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sivru-mcp-"));
  _clearIndexCacheForTest();
});

afterEach(async () => {
  _clearIndexCacheForTest();
  await rm(root, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  const abs = join(root, p);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function connectedClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "sivru-test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("mcp-entry — tools/list", () => {
  it("advertises exactly the search and find_related tools", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(["explain", "find_related", "search"]);

      const search = result.tools.find((t) => t.name === "search");
      expect(search?.description).toMatch(/semantic \+ lexical code search/i);
      expect(search?.inputSchema.type).toBe("object");
      expect(search?.inputSchema.required).toEqual(["query"]);

      const findRelated = result.tools.find((t) => t.name === "find_related");
      expect(findRelated?.description).toMatch(/find code related to a symbol/i);
      expect(findRelated?.description).not.toMatch(/not yet implemented/i);
      expect(findRelated?.inputSchema.required).toEqual([
        "filePath",
        "startLine",
        "endLine",
      ]);

      const explain = result.tools.find((t) => t.name === "explain");
      expect(explain?.description).toMatch(/public API, callers, callees/i);
      expect(explain?.inputSchema.required).toEqual(["path"]);
    } finally {
      await close();
    }
  });
});

describe("mcp-entry — search tool over the in-memory client", () => {
  it("returns a JSON-envelope hit for matching content with latency metadata", async () => {
    await write("auth/login.ts", "function authenticate(token) { /* validate jwt */ }");
    await write("ui/button.ts", "function Button() { return null }");

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "authenticate token", path: root, top: 3, hybrid: false },
      });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content.length).toBeGreaterThan(0);
      expect(content[0]?.type).toBe("text");
      const envelope = JSON.parse(content[0]?.text ?? "{}") as {
        query: string;
        mode: string;
        latencyMs: number;
        refreshMs: number;
        resultCount: number;
        results: Array<{
          filePath: string;
          startLine: number;
          endLine: number;
          score: number;
          preview: string;
        }>;
      };
      expect(envelope.query).toBe("authenticate token");
      expect(envelope.mode).toBe("bm25");
      expect(envelope.latencyMs).toBeGreaterThan(0);
      expect(envelope.refreshMs).toBeGreaterThanOrEqual(0);
      expect(envelope.resultCount).toBeGreaterThan(0);
      expect(envelope.results[0]?.filePath).toMatch(/auth\/login\.ts/);
      expect(envelope.results[0]?.preview).toMatch(/authenticate/);
      expect(envelope.results[0]?.score).toBeTypeOf("number");
    } finally {
      await close();
    }
  });

  it("returns an empty-results envelope for a query with no hits", async () => {
    await write("a.ts", "const x = 1;");
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "absolutelyNoSuchSymbolXyz", path: root, top: 3, hybrid: false },
      });
      expect(result.isError).toBe(false);
      const content = result.content as Array<{ type: string; text: string }>;
      const envelope = JSON.parse(content[0]?.text ?? "{}") as {
        resultCount: number;
        results: unknown[];
        latencyMs: number;
      };
      expect(envelope.resultCount).toBe(0);
      expect(envelope.results).toEqual([]);
      expect(envelope.latencyMs).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

describe("mcp-entry — search tool argument validation", () => {
  it("returns isError: true for an empty query", async () => {
    const result = await searchTool({ query: "", path: root });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/query.*non-empty/i);
  });

  it("returns isError: true when arguments are missing entirely", async () => {
    const result = await searchTool({});
    expect(result.isError).toBe(true);
  });

  it("rejects out-of-range top", async () => {
    const result = await searchTool({ query: "x", path: root, top: 999 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/top/);
  });
});

describe("mcp-entry — find_related tool", () => {
  it("returns a JSON envelope with related hits + latency", async () => {
    await write(
      "auth/login.ts",
      "function authenticate(token) {\n  // validate jwt\n  return verifyJWT(token);\n}\n",
    );
    await write(
      "auth/jwt.ts",
      "function verifyJWT(token) {\n  // authenticate jwt token\n  return decode(token);\n}\n",
    );
    await write("ui/button.ts", "function Button() {\n  return null;\n}\n");

    const result = await findRelatedTool({
      filePath: "auth/login.ts",
      startLine: 1,
      endLine: 4,
      path: root,
      top: 5,
      hybrid: false,
    });
    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
      query: string;
      latencyMs: number;
      results: Array<{ filePath: string; preview: string }>;
    };
    expect(envelope.query).toMatch(/find_related auth\/login\.ts:1-4/);
    expect(envelope.latencyMs).toBeGreaterThan(0);
    // Results must include auth/jwt.ts but exclude the source file.
    const filePaths = envelope.results.map((r) => r.filePath);
    expect(filePaths).toContain("auth/jwt.ts");
    expect(filePaths).not.toContain("auth/login.ts");
  });

  it("returns an empty-results envelope when the line range doesn't overlap any chunk", async () => {
    await write("a.ts", "const x = 1;\n");
    const result = await findRelatedTool({
      filePath: "a.ts",
      startLine: 100,
      endLine: 200,
      path: root,
      top: 5,
      hybrid: false,
    });
    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
      resultCount: number;
      results: unknown[];
      message?: string;
    };
    expect(envelope.resultCount).toBe(0);
    expect(envelope.results).toEqual([]);
    expect(envelope.message).toBe("no related chunks found");
  });

  it("returns isError: true when filePath is missing", async () => {
    const result = await findRelatedTool({ startLine: 1, endLine: 10, path: root });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/filePath/);
  });

  it("returns isError: true for negative line numbers", async () => {
    const result = await findRelatedTool({
      filePath: "x.ts",
      startLine: -1,
      endLine: 10,
      path: root,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/startLine/);
  });

  it("returns isError: true when endLine < startLine", async () => {
    const result = await findRelatedTool({
      filePath: "x.ts",
      startLine: 10,
      endLine: 1,
      path: root,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/endLine/);
  });

  it("rejects out-of-range top", async () => {
    const result = await findRelatedTool({
      filePath: "x.ts",
      startLine: 1,
      endLine: 5,
      path: root,
      top: 999,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/top/);
  });
});

describe("mcp-entry — routing-hint drift guard", () => {
  // DESIGN-0003 §4 finding 5: the MCP tool descriptions are a one-line
  // compression of the canonical SKILL.md routing policy, kept in sync by
  // hand. These assertions fail CI if an edit deletes a routing hint.
  it("search description keeps the grep-for-identifiers hint", () => {
    expect(SEARCH_TOOL_DESCRIPTION).toMatch(/grep/i);
    expect(SEARCH_TOOL_DESCRIPTION).toMatch(/natural-language or behavioural/i);
  });

  it("find_related description keeps the after-edit hint", () => {
    expect(FIND_RELATED_TOOL_DESCRIPTION).toMatch(/after editing/i);
    expect(FIND_RELATED_TOOL_DESCRIPTION).toMatch(/callers/i);
  });
});

describe("mcp-entry — explain tool argument validation", () => {
  it("requires `path`", () => {
    const out = parseExplainArgs({});
    expect("error" in out).toBe(true);
  });

  it("rejects depth != 1", () => {
    const out = parseExplainArgs({ path: "src/foo.ts", depth: 2 });
    expect("error" in out).toBe(true);
  });

  it("rejects negative `since`", () => {
    const out = parseExplainArgs({ path: "src/foo.ts", since: -1 });
    expect("error" in out).toBe(true);
  });

  it("parses `path::symbol` into separate fields", () => {
    const out = parseExplainArgs({ path: "src/foo.ts::doThing" });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.path).toBe("src/foo.ts");
    expect(out.symbol).toBe("doThing");
  });

  it("`symbol` arg overrides `path::sym` form", () => {
    const out = parseExplainArgs({
      path: "src/foo.ts::ignored",
      symbol: "winning",
    });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.symbol).toBe("winning");
  });
});

describe("mcp-entry — explain tool", () => {
  function gitInitInRoot(): void {
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", root, "config", "user.email", "t@t"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", root, "config", "user.name", "t"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"], {
      stdio: "ignore",
    });
  }

  it("returns the canonical envelope with the artifact", async () => {
    gitInitInRoot();
    await write("src/foo.ts", "export function foo() { return 1; }\n");
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "c1"], {
      stdio: "ignore",
    });

    const result = await explainTool({
      path: "src/foo.ts",
      repoRoot: root,
    });
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    const envelope = JSON.parse(text) as {
      tool: string;
      path: string;
      latencyMs: number;
      refreshMs: number;
      refreshDelta: {
        modified: number;
        added: number;
        removed: number;
        embedsRecomputed: number;
      };
      artifact: { path: string; public_api: Array<{ name: string }>; footer: string };
    };
    expect(envelope.tool).toBe("sivru.explain");
    expect(envelope.path).toBe("src/foo.ts");
    expect(envelope.latencyMs).toBeGreaterThan(0);
    expect(envelope.refreshMs).toBeGreaterThanOrEqual(0);
    expect(envelope.artifact.path).toBe("src/foo.ts");
    expect(envelope.artifact.public_api.map((e) => e.name)).toContain("foo");
    expect(typeof envelope.artifact.footer).toBe("string");
  });

  it("returns isError for an absolute path (SIVRU-E2001)", async () => {
    const result = await explainTool({ path: "/etc/passwd", repoRoot: root });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/SIVRU-E2001/);
  });

  it("returns isError when diff: true (v0.5 defers)", async () => {
    const result = await explainTool({
      path: "src/foo.ts",
      repoRoot: root,
      diff: true,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/diff/i);
  });
});

describe("mcp-entry — explain routing hint", () => {
  it("description carries the before-edit hint", () => {
    expect(EXPLAIN_TOOL_DESCRIPTION).toMatch(/before editing/i);
    expect(EXPLAIN_TOOL_DESCRIPTION).toMatch(/callers, callees/i);
  });
});

describe("mcp-entry — index cache", () => {
  it("does not rebuild the index on a second search of the same path", async () => {
    await write("a.ts", "function alpha() {}");
    await write("b.ts", "function beta() {}");

    // Pin hybrid: false explicitly. The default flipped to hybrid: true,
    // which would trigger a model download in CI / on a fresh machine.
    const first = await searchTool({ query: "alpha", path: root, top: 3, hybrid: false });
    expect(first.isError).toBe(false);

    const path = root;
    const buildsAfterFirst = _indexBuildCountForTest(path, false);
    expect(buildsAfterFirst).toBe(1);

    const second = await searchTool({ query: "beta", path: root, top: 3, hybrid: false });
    expect(second.isError).toBe(false);

    const buildsAfterSecond = _indexBuildCountForTest(path, false);
    expect(buildsAfterSecond).toBe(1);
  });
});
