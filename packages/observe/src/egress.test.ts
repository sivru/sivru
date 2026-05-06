// Privacy boundary (DESIGN.md §5.5): @sivru/observe must not make any
// outbound network calls. This file enforces that two ways:
//
//   1. Static — no source file imports `node:http`, `node:https`, `node:net`,
//      `node:tls`, or `undici`. The check walks `src/` and fails on any
//      `from "<banned>"` occurrence in non-test files. Without those imports,
//      `http.request` / `https.request` / `net.connect` are unreachable from
//      observe code paths.
//   2. Runtime — wrap global `fetch` with a spy that throws on call, then
//      exercise representative reads (listSessions + readSession over a
//      fixture). The spy must remain at zero calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listSessions, readSession } from "./index.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BANNED_IMPORTS = ["node:http", "node:https", "node:net", "node:tls", "undici"];

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Files under `src/server/` are allowed to import `node:http`/`node:https`
 * because the server uses `createServer` to LISTEN on localhost — that's
 * an inbound listener, not outbound traffic. The runtime fetch spy and
 * the static check on the rest of the package still guard outbound.
 */
function isServerFile(absPath: string): boolean {
  return absPath.includes(`${SRC_DIR}/server/`) || absPath.includes(`${SRC_DIR}\\server\\`);
}

describe("@sivru/observe — privacy boundary (DESIGN.md §5.5)", () => {
  it("data-layer source files don't import a network module", async () => {
    const files = (await listTsFiles(SRC_DIR)).filter((f) => !isServerFile(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const mod of BANNED_IMPORTS) {
        const pattern = new RegExp(`from\\s+["']${mod.replace(":", "[:]")}["']`);
        expect(text, `${file} must not import ${mod}`).not.toMatch(pattern);
      }
    }
  });

  describe("runtime egress check", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), "sivru-egress-"));
      if (typeof globalThis.fetch === "function") {
        fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
          throw new Error("egress: fetch called from observe");
        }) as never);
      }
    });

    afterEach(async () => {
      fetchSpy?.mockRestore();
      await rm(tmp, { recursive: true, force: true });
    });

    it("listSessions + readSession make zero outbound fetch calls", async () => {
      const projectsRoot = join(tmp, "projects");
      const projectDir = join(projectsRoot, "-fake-project");
      await mkdir(projectDir, { recursive: true });
      const sessionPath = join(projectDir, "sess-001.jsonl");
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "hello" },
            sessionId: "sess-001",
            timestamp: "2026-05-04T00:00:00Z",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "hi back" },
                { type: "tool_use", name: "Read", input: { path: "x" } },
              ],
            },
            sessionId: "sess-001",
            timestamp: "2026-05-04T00:00:01Z",
          }),
        ].join("\n") + "\n",
      );

      const sessions = await listSessions({ projectsRoot });
      expect(sessions).toHaveLength(1);

      const events = [];
      for await (const event of readSession(sessionPath)) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThan(0);

      expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);
    });
  });
});
