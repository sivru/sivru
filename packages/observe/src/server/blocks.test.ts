// DESIGN-0021 slot 1 — /api/blocks route tests.
//
// Fixtures are written into a temp dir UNDER the user's homedir so the
// rootPath containment check (homedir OR git tree) passes without needing a
// real git repo on the CI box.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createObserveApp } from "./app.js";
import { _internal, buildBlocksResponse, isWatchNoise, resolveFileWithinRoot } from "./blocks.js";
import { acknowledgeDiagnostic, editBlock } from "../handlers/block/index.js";

// A reciprocal pair (serviceA <-> helperB) plus an asymmetric edge
// (serviceC -> helperB, no back-reference) so the graph emits a
// SIVRU-E234 collaborator-asymmetric diagnostic.
const FILE_A = `/**
 * @sivru
 * schema: 1
 * role: service
 * responsibility: does A things and calls into helperB
 * collaborators: [helperB]
 * maturity: stable
 * @end
 */
export function serviceA() {
  return helperB();
}
`;

const FILE_B = `/**
 * @sivru
 * schema: 1
 * role: helper
 * responsibility: helps serviceA do its work
 * collaborators: [serviceA]
 * maturity: stable
 * @end
 */
export function helperB() {
  return 1;
}
`;

const FILE_C = `/**
 * @sivru
 * schema: 1
 * role: service
 * responsibility: another caller of helperB that helperB does not name back
 * collaborators: [helperB]
 * maturity: experimental
 * @end
 */
export function serviceC() {
  return helperB();
}
`;

describe("/api/blocks (DESIGN-0021 slot 1)", () => {
  let root: string;
  const app = createObserveApp();

  beforeAll(async () => {
    // mkdtemp under homedir keeps the path inside the containment surface.
    root = await mkdtemp(join(homedir(), ".sivru-blocks-test-"));
    await writeFile(join(root, "a.ts"), FILE_A);
    await writeFile(join(root, "b.ts"), FILE_B);
    await writeFile(join(root, "c.ts"), FILE_C);
    // A nested file to exercise the detail route's encoded-slash handling.
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(
      join(root, "src", "deep", "d.ts"),
      FILE_A.replace(/serviceA/g, "serviceD").replace("[helperB]", "[]"),
    );
    // A file with a fence but malformed YAML → block:null, drives filesSkipped.
    await writeFile(
      join(root, "bad.ts"),
      `/**\n * @sivru\n * schema: 1\n * role: [unclosed\n * @end\n */\nexport function bad() {}\n`,
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns nodes, edges and diagnostics for a valid rootPath", async () => {
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/blocks?rootPath=${encodeURIComponent(root)}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rootPath: string;
      nodes: Array<{ name: string; block: unknown; diagnostics: unknown[] }>;
      edges: Array<{ from: string; to: string; reciprocal: boolean }>;
      diagnostics: Array<{ code: string }>;
      filesSkipped: number;
    };
    // Shape compatible with computeBlockGraph output (nodes/edges/diagnostics).
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.diagnostics)).toBe(true);

    // serviceD lives in src/deep/ with no collaborators — an orphan node.
    // bad.ts has block:null so it is NOT a node, but IS counted in filesSkipped.
    const names = body.nodes.map((n) => n.name).sort();
    expect(names).toEqual(["helperB", "serviceA", "serviceC", "serviceD"]);
    expect(body.filesSkipped).toBe(1);

    // Reciprocal pair A<->B, asymmetric C->B.
    const recip = body.edges.find((e) => e.from === "serviceA" && e.to === "helperB");
    expect(recip?.reciprocal).toBe(true);
    const asym = body.edges.find((e) => e.from === "serviceC" && e.to === "helperB");
    expect(asym?.reciprocal).toBe(false);

    // E234 collaborator-asymmetric fires on the one-sided edge.
    expect(body.diagnostics.some((d) => d.code === "SIVRU-E234")).toBe(true);

    // Nodes carry parsed content for the inspector.
    const a = body.nodes.find((n) => n.name === "serviceA");
    expect(a?.block).not.toBeNull();
  });

  it("returns single-block detail via /api/blocks/:filePath/:symbol", async () => {
    const res = await app.fetch(
      new Request(
        `http://127.0.0.1/api/blocks/${encodeURIComponent("a.ts")}/serviceA?rootPath=${encodeURIComponent(root)}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; block: { role: string } | null };
    expect(body.name).toBe("serviceA");
    expect(body.block?.role).toBe("service");
  });

  it("resolves a NESTED filePath (encoded slash) without double-decoding", async () => {
    // Regression: Hono already decodes path params, so the handler must NOT
    // decodeURIComponent again. encodeURIComponent turns "src/deep/d.ts" into a
    // single %2F-laden segment; Hono hands back the real path.
    const res = await app.fetch(
      new Request(
        `http://127.0.0.1/api/blocks/${encodeURIComponent("src/deep/d.ts")}/serviceD?rootPath=${encodeURIComponent(root)}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("serviceD");
  });

  it("404s for an unknown symbol", async () => {
    const res = await app.fetch(
      new Request(
        `http://127.0.0.1/api/blocks/${encodeURIComponent("a.ts")}/nope?rootPath=${encodeURIComponent(root)}`,
      ),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SIVRU-E248");
  });

  it("400s on missing rootPath", async () => {
    const res = await app.fetch(new Request("http://127.0.0.1/api/blocks"));
    expect(res.status).toBe(400);
  });

  it("400s on a relative rootPath", async () => {
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/blocks?rootPath=relative/path"),
    );
    expect(res.status).toBe(400);
  });

  it("400s on a non-existent (but containment-passing) rootPath", async () => {
    const ghost = join(homedir(), ".sivru-blocks-test-does-not-exist-xyz");
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/blocks?rootPath=${encodeURIComponent(ghost)}`),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SIVRU-E241");
  });

  it("400s on a filePath that escapes rootPath (path traversal)", async () => {
    const res = await app.fetch(
      new Request(
        `http://127.0.0.1/api/blocks/${encodeURIComponent("../../../../etc/passwd")}/x?rootPath=${encodeURIComponent(root)}`,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SIVRU-E247");
  });

  it("returns a 500 with a structured envelope when graph build throws", async () => {
    const original = _internal.buildBlocksResponse;
    _internal.buildBlocksResponse = async () => {
      throw new Error("boom");
    };
    try {
      const res = await app.fetch(
        new Request(`http://127.0.0.1/api/blocks?rootPath=${encodeURIComponent(root)}`),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("SIVRU-E246");
      expect(body.error).toContain("boom");
    } finally {
      _internal.buildBlocksResponse = original;
    }
  });
});

describe("/api/blocks/stream SSE", () => {
  let root: string;
  const app = createObserveApp();

  beforeAll(async () => {
    root = await mkdtemp(join(homedir(), ".sivru-blocks-sse-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("400s on missing rootPath", async () => {
    const res = await app.fetch(new Request("http://127.0.0.1/api/blocks/stream"));
    expect(res.status).toBe(400);
  });

  it("opens an event-stream and emits block.updated on a file change", async () => {
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/blocks/stream?rootPath=${encodeURIComponent(root)}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 14000;

    // Poke CONTINUOUSLY until we see the event (or the deadline). fs.watch can
    // attach late under CPU load; a fixed burst of writes could all land before
    // the watcher is listening, leaving nothing to catch. A steady stream keeps
    // a fresh write available whenever the watcher finally attaches — robust
    // without weakening the assertion (it still requires a real emitted event).
    let poking = true;
    let n = 0;
    const pokeLoop = async (): Promise<void> => {
      while (poking && Date.now() < deadline) {
        await writeFile(join(root, `poke-${n++}.ts`), `// change ${n}\n`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    void pokeLoop();

    try {
      while (Date.now() < deadline && !seen.includes("block.updated")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    } finally {
      poking = false;
      await reader.cancel().catch(() => {});
    }

    expect(seen).toContain("block.updated");
  }, 20_000);
});

describe("/api/blocks + /api/feedback mutation routes (slot 2)", () => {
  let root: string;
  const ro = createObserveApp(); // read-only
  const rw = createObserveApp({ writable: true });
  const ORIGIN = { Origin: "http://127.0.0.1:7676" };

  const FILE = `/**
 * @sivru
 * schema: 1
 * role: r
 * responsibility: original
 * maturity: experimental
 * @end
 */
export function thing() {}
`;

  beforeAll(async () => {
    root = await mkdtemp(join(homedir(), ".sivru-blocks-mut-"));
    await writeFile(join(root, "thing.ts"), FILE);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const post = (app: ReturnType<typeof createObserveApp>, path: string, body: unknown, headers: Record<string, string> = ORIGIN) =>
    app.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );

  it("405 + WRITABLE-DISABLED on a non-writable boot (with valid Origin)", async () => {
    const res = await post(ro, "/api/blocks/autofix", { rootPath: root, filePath: "thing.ts" });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SIVRU-WRITABLE-DISABLED");
  });

  it("403 when the Origin header is missing (CSRF)", async () => {
    const res = await post(rw, "/api/blocks/autofix", { rootPath: root, filePath: "thing.ts" }, {});
    expect(res.status).toBe(403);
  });

  it("autofix happy path returns ok", async () => {
    const res = await post(rw, "/api/blocks/autofix", { rootPath: root, filePath: "thing.ts" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { rewrites: number } };
    expect(body.ok).toBe(true);
    expect(body.data.rewrites).toBe(0);
  });

  it("400 + PATH-OUTSIDE-ROOT on filePath traversal", async () => {
    const res = await post(rw, "/api/blocks/autofix", { rootPath: root, filePath: "../../etc/passwd" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SIVRU-PATH-OUTSIDE-ROOT");
  });

  it("edit happy path rewrites the block", async () => {
    const res = await post(rw, "/api/blocks/edit", {
      rootPath: root,
      filePath: "thing.ts",
      symbol: "thing",
      block: { schema: 1, role: "edited-role", responsibility: "now updated", maturity: "stable" },
    });
    expect(res.status).toBe(200);
    const after = await readFile(join(root, "thing.ts"), "utf8");
    expect(after).toContain("role: edited-role");
  });

  it("edit 409 on a stale expectedMtimeMs", async () => {
    const res = await post(rw, "/api/blocks/edit", {
      rootPath: root,
      filePath: "thing.ts",
      symbol: "thing",
      block: { schema: 1, role: "r", responsibility: "x" },
      expectedMtimeMs: 1,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("SIVRU-FILE-CHANGED");
    expect(body.retryable).toBe(true);
  });

  it("acknowledge writes acknowledgments.jsonl", async () => {
    const res = await post(rw, "/api/blocks/acknowledge", {
      rootPath: root,
      diagnostic: { code: "SIVRU-E234", filePath: "thing.ts", symbolName: "thing" },
      note: "intentional",
    });
    expect(res.status).toBe(200);
    const ack = await readFile(join(root, ".sivru", "acknowledgments.jsonl"), "utf8");
    expect(ack).toContain("acknowledge");
  });

  it("POST /api/feedback (false-positive) then GET /api/feedback reads it (ungated)", async () => {
    await post(rw, "/api/feedback", {
      rootPath: root,
      kind: "false-positive",
      diagnostic: { code: "SIVRU-E235", filePath: "thing.ts", symbolName: "thing" },
      label: "false-positive",
    });
    // GET is ungated — read even from the read-only app.
    const res = await ro.fetch(
      new Request(`http://127.0.0.1/api/feedback?rootPath=${encodeURIComponent(root)}&kind=false-positive`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { records: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.records.length).toBeGreaterThanOrEqual(1);
  });

  it("/api/metrics reports the writable gauge", async () => {
    const res = await rw.fetch(new Request("http://127.0.0.1/api/metrics"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("sivru_observe_writable_mode 1");
    const roRes = await ro.fetch(new Request("http://127.0.0.1/api/metrics"));
    expect(await roRes.text()).toContain("sivru_observe_writable_mode 0");
  });
});

describe("acknowledgment suppression (DESIGN-0021 content-hash invalidation)", () => {
  let root: string;
  const ctx = () => ({ rootPath: root, actor: "ui" as const, writable: true });

  beforeAll(async () => {
    root = await mkdtemp(join(homedir(), ".sivru-blocks-ack-"));
    await writeFile(join(root, "a.ts"), FILE_A); // serviceA -> helperB (reciprocal)
    await writeFile(join(root, "b.ts"), FILE_B); // helperB -> serviceA
    await writeFile(join(root, "c.ts"), FILE_C); // serviceC -> helperB (asymmetric → E234)
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("suppresses an acknowledged finding, then re-fires it after the block changes", async () => {
    // Baseline: the E234 on serviceC is present.
    const before = await buildBlocksResponse(root);
    const e234 = before.diagnostics.find(
      (d) => d.code === "SIVRU-E234" && d.location?.filePath.endsWith("c.ts"),
    );
    expect(e234).toBeDefined();
    const cFile = e234!.location!.filePath;

    // Acknowledge it (server computes the current content hash).
    const ack = await acknowledgeDiagnostic(ctx(), {
      code: "SIVRU-E234",
      filePath: cFile,
      symbolName: "serviceC",
    });
    expect(ack.ok).toBe(true);

    // Now it's suppressed from the inbox.
    const after = await buildBlocksResponse(root);
    expect(after.diagnostics.some((d) => d.code === "SIVRU-E234" && d.location?.filePath === cFile)).toBe(false);

    // Change the block (edit bumps content → hash differs) → finding re-fires with a note.
    const edit = await editBlock(ctx(), cFile, "serviceC", {
      schema: 1,
      role: "service",
      responsibility: "CHANGED responsibility text",
      collaborators: ["helperB"],
      maturity: "experimental",
    });
    expect(edit.ok).toBe(true);

    const refired = await buildBlocksResponse(root);
    const back = refired.diagnostics.find((d) => d.code === "SIVRU-E234" && d.location?.filePath === cFile);
    expect(back).toBeDefined();
    expect(back!.message).toContain("previously acknowledged");
  });
});

describe("isWatchNoise", () => {
  it("filters high-churn non-block paths", () => {
    expect(isWatchNoise("node_modules/x/index.js")).toBe(true);
    expect(isWatchNoise(".git/HEAD")).toBe(true);
    expect(isWatchNoise("dist/index.js")).toBe(true);
    expect(isWatchNoise("packages/a/dist/foo.js")).toBe(true);
    expect(isWatchNoise("pnpm-lock.yaml")).toBe(true);
    expect(isWatchNoise("src/UserService.java")).toBe(false);
    expect(isWatchNoise("src/a.ts")).toBe(false);
  });
});

describe("resolveFileWithinRoot", () => {
  it("accepts a relative path under root", () => {
    expect(resolveFileWithinRoot("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
  });
  it("accepts an absolute path under root", () => {
    expect(resolveFileWithinRoot("/repo", "/repo/src/a.ts")).toBe("/repo/src/a.ts");
  });
  it("rejects traversal escaping root", () => {
    expect(resolveFileWithinRoot("/repo", "../../etc/passwd")).toBeNull();
  });
  it("rejects an absolute path outside root", () => {
    expect(resolveFileWithinRoot("/repo", "/etc/passwd")).toBeNull();
  });
});
