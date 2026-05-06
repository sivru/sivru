import type { AddressInfo } from "node:net";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHttpEmbeddingProvider,
  type HttpEmbeddingProviderOptions,
} from "./http.js";

type RequestRecord = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  recorded: RequestRecord,
) => void | Promise<void>;

type TestServer = {
  port: number;
  url: () => string;
  setHandler: (handler: Handler) => void;
  requests: RequestRecord[];
  close: () => Promise<void>;
};

async function startServer(): Promise<TestServer> {
  let handler: Handler = (_req, res) => {
    res.statusCode = 500;
    res.end("no handler set");
  };
  const requests: RequestRecord[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = undefined;
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      const record: RequestRecord = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: parsed,
      };
      requests.push(record);
      Promise.resolve(handler(req, res, record)).catch((err: unknown) => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end(err instanceof Error ? err.message : String(err));
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  return {
    port,
    url: () => `http://127.0.0.1:${port}/`,
    setHandler: (h: Handler) => {
      handler = h;
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

function jsonReply(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

describe("createHttpEmbeddingProvider", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("openai shape: embeds a single text", async () => {
    server.setHandler((_req, res) => {
      jsonReply(res, 200, { data: [{ embedding: [0.6, 0.8] }] });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "test-model",
      dim: 2,
      shape: "openai",
    });
    const vec = await provider.embed("hello");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(2);
    expect(Math.abs((vec[0] ?? 0) - 0.6)).toBeLessThan(1e-6);
    expect(Math.abs((vec[1] ?? 0) - 0.8)).toBeLessThan(1e-6);

    const recorded = server.requests[0];
    expect(recorded).toBeDefined();
    expect(recorded?.method).toBe("POST");
    const body = recorded?.body as { model?: string; input?: unknown };
    expect(body.model).toBe("test-model");
    expect(body.input).toEqual(["hello"]);
  });

  it("openai shape defaults when shape is omitted", async () => {
    server.setHandler((_req, res) => {
      jsonReply(res, 200, { data: [{ embedding: [1, 0, 0, 0] }] });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 4,
    });
    const vec = await provider.embed("x");
    expect(vec.length).toBe(4);
    expect(vec[0]).toBe(1);
  });

  it("ollama shape: embeds a single text", async () => {
    server.setHandler((_req, res) => {
      jsonReply(res, 200, { embedding: [0.6, 0.8] });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "test-model",
      dim: 2,
      shape: "ollama",
    });
    const vec = await provider.embed("hello");
    expect(vec.length).toBe(2);
    expect(Math.abs((vec[0] ?? 0) - 0.6)).toBeLessThan(1e-6);
    expect(Math.abs((vec[1] ?? 0) - 0.8)).toBeLessThan(1e-6);

    const recorded = server.requests[0];
    const body = recorded?.body as { model?: string; prompt?: string };
    expect(body.model).toBe("test-model");
    expect(body.prompt).toBe("hello");
  });

  it("openai embedBatch: one request, multiple results in order", async () => {
    server.setHandler((_req, res) => {
      jsonReply(res, 200, {
        data: [
          { embedding: [1, 0] },
          { embedding: [0, 1] },
          { embedding: [0.6, 0.8] },
        ],
      });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 2,
      shape: "openai",
    });
    const vecs = await provider.embedBatch?.(["a", "b", "c"]);
    expect(vecs).toBeDefined();
    if (!vecs) return;
    expect(vecs.length).toBe(3);
    expect(server.requests.length).toBe(1);
    const body = server.requests[0]?.body as { input?: unknown };
    expect(body.input).toEqual(["a", "b", "c"]);
    expect(vecs[0]?.[0]).toBe(1);
    expect(vecs[1]?.[1]).toBe(1);
    expect(Math.abs((vecs[2]?.[0] ?? 0) - 0.6)).toBeLessThan(1e-6);
  });

  it("ollama embedBatch: one request per text, results in order", async () => {
    const responses: number[][] = [
      [1, 0],
      [0, 1],
      [0.6, 0.8],
    ];
    let i = 0;
    server.setHandler((_req, res) => {
      const next = responses[i++] ?? [0, 0];
      jsonReply(res, 200, { embedding: next });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 2,
      shape: "ollama",
    });
    const vecs = await provider.embedBatch?.(["a", "b", "c"]);
    expect(vecs).toBeDefined();
    if (!vecs) return;
    expect(vecs.length).toBe(3);
    expect(server.requests.length).toBe(3);
    expect(vecs[0]?.[0]).toBe(1);
    expect(vecs[1]?.[1]).toBe(1);
    expect(Math.abs((vecs[2]?.[0] ?? 0) - 0.6)).toBeLessThan(1e-6);

    const prompts = server.requests.map((r) => (r.body as { prompt?: string }).prompt);
    expect(prompts).toEqual(["a", "b", "c"]);
  });

  it("L2-normalizes when server returns an unnormalized vector", async () => {
    server.setHandler((_req, res) => {
      jsonReply(res, 200, { data: [{ embedding: [3, 4] }] });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 2,
    });
    const vec = await provider.embed("x");
    expect(Math.abs((vec[0] ?? 0) - 0.6)).toBeLessThan(1e-6);
    expect(Math.abs((vec[1] ?? 0) - 0.8)).toBeLessThan(1e-6);
  });

  it("returns all-zero vector unchanged (no division by zero)", async () => {
    server.setHandler((_req, res) => {
      jsonReply(res, 200, { data: [{ embedding: [0, 0, 0, 0] }] });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 4,
    });
    const vec = await provider.embed("x");
    for (let i = 0; i < vec.length; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it("throws on dim mismatch with helpful message", async () => {
    server.setHandler((_req, res) => {
      jsonReply(res, 200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 2,
    });
    await expect(provider.embed("x")).rejects.toThrow(/expected dim 2 but got 3/);
    await expect(provider.embed("x")).rejects.toThrow(server.url());
  });

  it("throws with HTTP status on non-2xx response", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("internal error");
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 2,
    });
    await expect(provider.embed("x")).rejects.toThrow(/status 500/);
    await expect(provider.embed("x")).rejects.toThrow(server.url());
  });

  it("throws on timeout when server hangs", async () => {
    server.setHandler(() => {
      // Never respond — let the client time out.
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 2,
      timeoutMs: 150,
    });
    const start = Date.now();
    await expect(provider.embed("x")).rejects.toThrow(/timed out|aborted/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("forwards custom headers (Authorization)", async () => {
    let seenAuth: string | undefined;
    server.setHandler((req, res) => {
      const auth = req.headers["authorization"];
      seenAuth = typeof auth === "string" ? auth : Array.isArray(auth) ? auth[0] : undefined;
      jsonReply(res, 200, { data: [{ embedding: [1, 0] }] });
    });
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 2,
      headers: { Authorization: "Bearer xxx" },
    });
    await provider.embed("x");
    expect(seenAuth).toBe("Bearer xxx");
  });

  it("throws at construction time when url is missing", () => {
    const opts = { model: "m", dim: 2 } as unknown as HttpEmbeddingProviderOptions;
    expect(() => createHttpEmbeddingProvider(opts)).toThrow(/url/);
  });

  it("throws at construction time when model is missing", () => {
    const opts = { url: "http://x/", dim: 2 } as unknown as HttpEmbeddingProviderOptions;
    expect(() => createHttpEmbeddingProvider(opts)).toThrow(/model/);
  });

  it("throws at construction time when dim is missing or invalid", () => {
    const optsNoDim = { url: "http://x/", model: "m" } as unknown as HttpEmbeddingProviderOptions;
    expect(() => createHttpEmbeddingProvider(optsNoDim)).toThrow(/dim/);
    expect(() =>
      createHttpEmbeddingProvider({ url: "http://x/", model: "m", dim: 0 }),
    ).toThrow(/dim/);
    expect(() =>
      createHttpEmbeddingProvider({ url: "http://x/", model: "m", dim: -1 }),
    ).toThrow(/dim/);
    expect(() =>
      createHttpEmbeddingProvider({ url: "http://x/", model: "m", dim: 1.5 }),
    ).toThrow(/dim/);
  });

  it("throws when url is empty string", () => {
    expect(() =>
      createHttpEmbeddingProvider({ url: "", model: "m", dim: 2 }),
    ).toThrow(/url/);
  });

  it("returns dim from the provider matching configured dim", () => {
    const provider = createHttpEmbeddingProvider({
      url: server.url(),
      model: "m",
      dim: 384,
    });
    expect(provider.dim).toBe(384);
  });
});
