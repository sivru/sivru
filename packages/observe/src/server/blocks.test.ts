// DESIGN-0021 slot 1 — /api/blocks route tests.
//
// Fixtures are written into a temp dir UNDER the user's homedir so the
// rootPath containment check (homedir OR git tree) passes without needing a
// real git repo on the CI box.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createObserveApp } from "./app.js";
import { _internal, resolveFileWithinRoot } from "./blocks.js";

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
    };
    // Shape compatible with computeBlockGraph output (nodes/edges/diagnostics).
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.diagnostics)).toBe(true);

    const names = body.nodes.map((n) => n.name).sort();
    expect(names).toEqual(["helperB", "serviceA", "serviceC"]);

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
    const deadline = Date.now() + 8000;

    // Give the watcher a beat to attach, then poke the dir a few times.
    const poke = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(root, `poke-${i}.ts`), `// change ${i}\n`);
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    await new Promise((r) => setTimeout(r, 150));
    void poke();

    try {
      while (Date.now() < deadline && !seen.includes("block.updated")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    expect(seen).toContain("block.updated");
  }, 12_000);
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
