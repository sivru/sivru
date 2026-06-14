import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { computeStateId } from "@sivru/search";

import { loadModelAndHealth } from "./map-serve.js";
import { saveModelCache } from "./model-cache.js";
import type { ExplainerModel } from "./types.js";

let repo: string;
let modelCacheDir: string;
let healthCacheDir: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "sivru-map-serve-"));
  modelCacheDir = mkdtempSync(join(tmpdir(), "sivru-mc-"));
  healthCacheDir = mkdtempSync(join(tmpdir(), "sivru-hc-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  await writeFile(join(repo, "a.ts"), "export const x = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(modelCacheDir, { recursive: true, force: true });
  await rm(healthCacheDir, { recursive: true, force: true });
});

function tinyModel(stateId: string, head: string): ExplainerModel {
  return {
    schema: 1,
    repoPath: resolve(repo),
    stateId,
    head,
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
  };
}

describe("loadModelAndHealth — serve-stale (DESIGN-0024 T6)", () => {
  it("serves the newest cached model marked STALE when the current stateId misses", async () => {
    // Seed a model under a stateId that does NOT match the current clean HEAD.
    await saveModelCache(tinyModel("stale-old-state", "oldhead"), modelCacheDir);
    const served = await loadModelAndHealth(repo, { modelCacheDir, healthCacheDir });
    expect(served.model.stateId).toBe("stale-old-state");
    expect(served.freshAsOf.stale).toBe(true);
    expect(served.freshAsOf.sha).toBe("oldhead");
    expect(served.freshAsOf.note).toMatch(/working tree changed since/i);
  });

  it("serves a fresh (not stale) model when the current stateId hits", async () => {
    const current = await computeStateId(resolve(repo));
    await saveModelCache(tinyModel(current, "abc1234"), modelCacheDir);
    const served = await loadModelAndHealth(repo, { modelCacheDir, healthCacheDir });
    expect(served.model.stateId).toBe(current);
    expect(served.freshAsOf.stale).toBe(false);
    expect(served.freshAsOf.dirty).toBe(false); // clean committed repo
  });

  it("freshAsOf.dirty reflects the SERVED model's build state, not the current tree", async () => {
    // Served model was built dirty (stateId carries the `:diffhash` marker), even
    // though it is served stale against a now-clean current state.
    await saveModelCache(tinyModel("sha:deadbeefdirty", "dirtyhd"), modelCacheDir);
    const served = await loadModelAndHealth(repo, { modelCacheDir, healthCacheDir });
    expect(served.freshAsOf.stale).toBe(true);
    expect(served.freshAsOf.dirty).toBe(true);
  });
});
