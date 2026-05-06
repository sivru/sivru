// W6 — server.test.ts
// In-process tests for the Hono app via `app.fetch(new Request(...))`. No
// real port is bound for endpoint tests; one smoke test exercises the
// listener boot/shutdown path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSource } from "../sources/adapter.js";
import { readSession } from "../sources/jsonl/index.js";
import type { Session, SivruEvent } from "../types.js";
import { createObserveApp } from "./app.js";
import { createObserveServer } from "./index.js";

const SESSION_A: Session = {
  id: "sess-a",
  path: "/tmp/fake/sess-a.jsonl",
  project: "fake",
  startedAt: "2026-05-04T00:00:00Z",
  updatedAt: "2026-05-04T00:00:05Z",
  eventCount: 5,
};

const SESSION_B: Session = {
  id: "sess-b",
  path: "/tmp/fake/sess-b.jsonl",
  project: "fake",
  startedAt: "2026-05-04T00:01:00Z",
  updatedAt: "2026-05-04T00:01:10Z",
  eventCount: 3,
};

function fakeEvent(sessionId: string, index: number): SivruEvent {
  return {
    kind: "user_message",
    sessionId,
    index,
    text: `event-${index}`,
    raw: { index },
  };
}

function makeFakeSource(): SessionSource {
  const events: Record<string, SivruEvent[]> = {
    "/tmp/fake/sess-a.jsonl": [0, 1, 2, 3, 4].map((i) => fakeEvent("sess-a", i)),
    "/tmp/fake/sess-b.jsonl": [0, 1, 2].map((i) => fakeEvent("sess-b", i)),
  };
  return {
    listSessions: async () => [SESSION_A, SESSION_B],
    readSession: async function* (sessionPath: string): AsyncIterable<SivruEvent> {
      const list = events[sessionPath] ?? [];
      for (const ev of list) yield ev;
    },
  };
}

function buildApp() {
  return createObserveApp({ source: makeFakeSource() });
}

describe("@sivrujs/observe — HTTP server", () => {
  describe("GET /api/health", () => {
    it("returns ok + version", async () => {
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; version: string };
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe("string");
      expect(body.version.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/sessions", () => {
    it("returns sessions in source order", async () => {
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/sessions"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Session[] };
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions[0]?.id).toBe("sess-a");
      expect(body.sessions[1]?.id).toBe("sess-b");
    });
  });

  describe("GET /api/sessions/:id/events", () => {
    it("returns events for a known session", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/sess-a/events"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string; events: SivruEvent[] };
      expect(body.sessionId).toBe("sess-a");
      expect(body.events).toHaveLength(5);
      expect(body.events[0]?.index).toBe(0);
    });

    it("respects ?limit=N (returns at most N, oldest dropped)", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/sess-a/events?limit=2"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string; events: SivruEvent[] };
      expect(body.events).toHaveLength(2);
      // We keep the most-recent N: indices 3 and 4 from a 5-event stream.
      expect(body.events[0]?.index).toBe(3);
      expect(body.events[1]?.index).toBe(4);
    });

    it("404s for an unknown id", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/missing/events"),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not found");
    });
  });

  describe("GET /api/sessions/:id/replay", () => {
    it("returns the per-event counterfactual replay", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/sess-a/replay"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionId: string;
        events: Array<{
          index: number;
          replaceableBySivru: boolean;
          actualTokens: number;
          counterfactualTokens: number;
        }>;
        totals: {
          actualTokens: number;
          counterfactualTokens: number;
          tokensSaved: number;
          replaceableCallCount: number;
          percentSaved: number;
        };
      };
      expect(body.sessionId).toBe("sess-a");
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.totals).toBeDefined();
      expect(body.totals.actualTokens).toBeGreaterThanOrEqual(0);
      // tokensSaved is the difference between actual and counterfactual.
      expect(body.totals.tokensSaved).toBe(
        body.totals.actualTokens - body.totals.counterfactualTokens,
      );
    });

    it("404s for an unknown session id", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/missing/replay"),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("CORS", () => {
    it("allows http://localhost:5173", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
          },
        }),
      );
      expect([200, 204]).toContain(res.status);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:5173",
      );
    });

    it("allows http://127.0.0.1:5173", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          method: "OPTIONS",
          headers: {
            Origin: "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "GET",
          },
        }),
      );
      expect([200, 204]).toContain(res.status);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://127.0.0.1:5173",
      );
    });

    it("does not echo a non-localhost origin", async () => {
      const app = buildApp();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions", {
          method: "OPTIONS",
          headers: {
            Origin: "https://attacker.example.com",
            "Access-Control-Request-Method": "GET",
          },
        }),
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe(
        "https://attacker.example.com",
      );
    });
  });

  describe("GET /api/sessions/:id/stream (SSE live tail)", () => {
    let tmp: string;
    let sessionPath: string;

    // Build a source that points at a REAL on-disk jsonl file so the SSE
    // handler's watchFile / createReadStream paths exercise actual i/o.
    function makeFsSource(): SessionSource {
      const session: Session = {
        id: "live-sess",
        path: sessionPath,
        project: "fake",
        startedAt: null,
        updatedAt: null,
        eventCount: 0,
      };
      return {
        listSessions: async () => [session],
        readSession: (p: string) => readSession(p),
      };
    }

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), "sivru-sse-"));
      sessionPath = join(tmp, "live-sess.jsonl");
      await writeFile(
        sessionPath,
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hello-initial" },
          sessionId: "live-sess",
          timestamp: "2026-05-04T00:00:00Z",
        }) + "\n",
      );
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it("404s for an unknown session id", async () => {
      const app = createObserveApp({ source: makeFsSource() });
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/missing/stream"),
      );
      expect(res.status).toBe(404);
    });

    it("emits existing events as `event: event` SSE frames on connect", async () => {
      const app = createObserveApp({ source: makeFsSource() });
      const ac = new AbortController();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/live-sess/stream", {
          signal: ac.signal,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

      const body = res.body;
      expect(body).not.toBeNull();
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      // Drain frames until we see at least one full SSE message (terminated
      // by a blank line).
      let buf = "";
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (/event:\s*event\n[\s\S]*?\n\n/.test(buf)) break;
      }

      try {
        expect(buf).toMatch(/event:\s*event\n/);
        expect(buf).toMatch(/data:\s*\{[\s\S]*"kind":"user_message"/);
        expect(buf).toMatch(/"text":"hello-initial"/);
      } finally {
        ac.abort();
        try {
          await reader.cancel();
        } catch {
          // ignore — already aborted.
        }
      }
    });

    it("streams newly-appended lines to an open client", async () => {
      const app = createObserveApp({ source: makeFsSource() });
      const ac = new AbortController();
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/live-sess/stream", {
          signal: ac.signal,
        }),
      );
      expect(res.status).toBe(200);

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      // Drain initial backfill frame first.
      let buf = "";
      const drainUntil = async (re: RegExp, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) return false;
          buf += decoder.decode(value, { stream: true });
          if (re.test(buf)) return true;
        }
        return false;
      };

      try {
        const sawInitial = await drainUntil(/"text":"hello-initial"/, 2000);
        expect(sawInitial).toBe(true);

        // Append a new line. watchFile polls at 250ms; allow generously.
        await appendFile(
          sessionPath,
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "hello-appended" },
            sessionId: "live-sess",
            timestamp: "2026-05-04T00:00:01Z",
          }) + "\n",
        );

        const sawAppend = await drainUntil(/"text":"hello-appended"/, 5000);
        expect(sawAppend).toBe(true);
      } finally {
        ac.abort();
        try {
          await reader.cancel();
        } catch {
          // ignore.
        }
      }
    });
  });

  describe("GET /api/bench-history", () => {
    let tmpHome: string;

    beforeEach(async () => {
      tmpHome = mkdtempSync(join(tmpdir(), "observe-bench-history-"));
      vi.stubEnv("HOME", tmpHome);
      // We don't override XDG dirs — only HOME — because bench-history
      // routes resolve via os.homedir() directly.
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(tmpHome, { recursive: true, force: true });
    });

    function writeRun(id: string, entry: object): void {
      const dir = join(tmpHome, ".cache", "sivru", "bench-history");
      // mkdir recursively in sync — we're in a test, simplicity wins.
      try {
        require("node:fs").mkdirSync(dir, { recursive: true });
      } catch {
        // already exists
      }
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(entry));
    }

    it("returns empty list when no runs exist", async () => {
      const app = createObserveApp({ source: makeFakeSource() });
      const res = await app.fetch(new Request("http://localhost/api/bench-history"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: unknown[] };
      expect(body.runs).toEqual([]);
    });

    it("lists runs newest-first and reads them back", async () => {
      writeRun("2026-05-01T10-00-00", {
        formatVersion: 1,
        startedAt: "2026-05-01T10:00:00.000Z",
        sivruVersion: "0.1.0-rc.1",
        node: "20.0.0",
        platform: "darwin",
        argv: [],
        repos: [{ project: "p", basename: "p", sessionCount: 1, queries: ["q"], models: [] }],
      });
      writeRun("2026-05-03T10-00-00", {
        formatVersion: 1,
        startedAt: "2026-05-03T10:00:00.000Z",
        sivruVersion: "0.1.0-rc.1",
        node: "20.0.0",
        platform: "darwin",
        argv: [],
        repos: [],
      });

      const app = createObserveApp({ source: makeFakeSource() });
      const list = (await (
        await app.fetch(new Request("http://localhost/api/bench-history"))
      ).json()) as { runs: Array<{ id: string; startedAt: string }> };
      expect(list.runs.length).toBe(2);
      expect(list.runs[0]?.id).toMatch(/^2026-05-03/);
      expect(list.runs[0]?.startedAt).toBe("2026-05-03T10:00:00");
      expect(list.runs[1]?.id).toMatch(/^2026-05-01/);

      const detailRes = await app.fetch(
        new Request(`http://localhost/api/bench-history/${list.runs[0]!.id}`),
      );
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as { formatVersion: number; argv: unknown[] };
      expect(detail.formatVersion).toBe(1);
      expect(detail.argv).toEqual([]);
    });

    it("returns 404 for unknown id", async () => {
      const app = createObserveApp({ source: makeFakeSource() });
      const res = await app.fetch(
        new Request("http://localhost/api/bench-history/9999-99-99T99-99-99"),
      );
      expect(res.status).toBe(404);
    });

    it("rejects path-traversal ids with 400", async () => {
      const app = createObserveApp({ source: makeFakeSource() });
      const res = await app.fetch(
        new Request("http://localhost/api/bench-history/..%2Fpasswd"),
      );
      expect(res.status).toBe(400);
    });

    it("returns 410 on incompatible formatVersion", async () => {
      writeRun("2026-05-04T10-00-00", { formatVersion: 99, repos: [] });
      const app = createObserveApp({ source: makeFakeSource() });
      const res = await app.fetch(
        new Request("http://localhost/api/bench-history/2026-05-04T10-00-00"),
      );
      expect(res.status).toBe(410);
    });
  });

  describe("createObserveServer (smoke)", () => {
    it("binds to 127.0.0.1 on an OS-picked port and closes cleanly", async () => {
      const server = await createObserveServer({
        port: 0,
        source: makeFakeSource(),
      });
      try {
        expect(server.host).toBe("127.0.0.1");
        expect(server.port).toBeGreaterThan(0);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      } finally {
        await server.close();
      }
    });
  });
});
