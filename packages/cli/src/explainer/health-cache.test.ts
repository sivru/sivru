import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { loadHealthCache, saveHealthCache } from "./health-cache.js";
import type { ModelHealth } from "./health.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sivru-health-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function health(over: Partial<ModelHealth> = {}): ModelHealth {
  return {
    schema: 1,
    stateId: "state-abc",
    byId: {
      "symbol:a#f": { hot: { score: 9, rank: 1 }, inCycle: null, driftBroken: [], unguardable: [] },
    },
    ...over,
  };
}

describe("health cache (DESIGN-0024 T2)", () => {
  it("round-trips health for (repoPath, stateId) — the 2nd map call's cache hit", async () => {
    const h = health();
    await saveHealthCache("/repo", h, dir);
    expect(await loadHealthCache("/repo", "state-abc", dir)).toEqual(h);
  });

  it("misses when the stateId differs (working tree changed)", async () => {
    await saveHealthCache("/repo", health({ stateId: "s1" }), dir);
    expect(await loadHealthCache("/repo", "s2", dir)).toBeNull();
  });

  it("returns null (not a throw) on a corrupt cache file", async () => {
    const slug = createHash("sha256").update(resolve("/repo")).digest("hex");
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, "state-abc.json"), "{ not json");
    expect(await loadHealthCache("/repo", "state-abc", dir)).toBeNull();
  });

  it("rejects a forward-incompatible schema", async () => {
    const h = health();
    await saveHealthCache("/repo", h, dir);
    const slug = createHash("sha256").update(resolve("/repo")).digest("hex");
    writeFileSync(join(dir, slug, "state-abc.json"), JSON.stringify({ ...h, schema: 99 }));
    expect(await loadHealthCache("/repo", "state-abc", dir)).toBeNull();
  });
});
