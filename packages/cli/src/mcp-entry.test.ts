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
  findRelatedTool,
  searchTool,
} from "./mcp-entry.js";

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
      expect(names).toEqual(["find_related", "search"]);

      const search = result.tools.find((t) => t.name === "search");
      expect(search?.description).toMatch(/search a local code repository/i);
      expect(search?.inputSchema.type).toBe("object");
      expect(search?.inputSchema.required).toEqual(["query"]);

      const findRelated = result.tools.find((t) => t.name === "find_related");
      expect(findRelated?.description).toMatch(/find code chunks similar/i);
      expect(findRelated?.description).not.toMatch(/not yet implemented/i);
      expect(findRelated?.inputSchema.required).toEqual([
        "filePath",
        "startLine",
        "endLine",
      ]);
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
