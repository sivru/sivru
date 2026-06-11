import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { loadModelCache, saveModelCache } from "./model-cache.js";
import type { ExplainerModel } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sivru-explainer-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function model(over: Partial<ExplainerModel> = {}): ExplainerModel {
  return {
    schema: 1,
    repoPath: "/repo",
    stateId: "state-abc",
    head: "test",
    root: {
      id: "system",
      level: "system",
      name: "r",
      path: "",
      children: [],
      derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
      block: null,
    },
    stats: { files: 0, symbols: 0, modules: 0 },
    ...over,
  };
}

describe("model cache", () => {
  it("round-trips a model for (repoPath, stateId)", async () => {
    const m = model();
    await saveModelCache(m, dir);
    const back = await loadModelCache("/repo", "state-abc", dir);
    expect(back).toEqual(m);
  });

  it("misses when the stateId differs (repo changed)", async () => {
    await saveModelCache(model({ stateId: "state-1" }), dir);
    expect(await loadModelCache("/repo", "state-2", dir)).toBeNull();
  });

  it("misses on a different repoPath", async () => {
    await saveModelCache(model({ repoPath: "/a" }), dir);
    expect(await loadModelCache("/b", "state-abc", dir)).toBeNull();
  });

  it("returns null (not a throw) on a corrupt cache file", async () => {
    const slug = createHash("sha256").update(resolve("/repo")).digest("hex");
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, "state-abc.json"), "{ not json");
    expect(await loadModelCache("/repo", "state-abc", dir)).toBeNull();
  });

  it("rejects a forward-incompatible schema", async () => {
    // Write a model whose on-disk schema is a future version.
    const m = model();
    await saveModelCache(m, dir);
    const slug = createHash("sha256").update(resolve("/repo")).digest("hex");
    writeFileSync(
      join(dir, slug, "state-abc.json"),
      JSON.stringify({ ...m, schema: 99 }),
    );
    expect(await loadModelCache("/repo", "state-abc", dir)).toBeNull();
  });
});
