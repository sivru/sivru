// Integration: build the explainer model against the real sivru repo, with the
// real machinery (computeStateId + buildCommitCounts + loadOrBuildSymbolIndex +
// extractBlocks) — no mocks. Proves the composition holds and the build stays
// within a generous budget. The fine-grained logic is covered by model.test.ts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStateId } from "@sivru/search";

import { buildExplainerModel, projectModel } from "./model.js";
import { saveModelCache } from "./model-cache.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/src/explainer
const repoRoot = resolve(here, "..", "..", "..", ".."); // → repo root

function gitWorks(): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const collect = (n: ExplainerNode): ExplainerNode[] => [
  n,
  ...n.children.flatMap(collect),
];

describe("explainer model — integration on the sivru repo", () => {
  it.runIf(gitWorks())(
    "builds a coherent four-level model from the real machinery",
    async () => {
      const m = await buildExplainerModel(repoRoot, {});

      expect(m.schema).toBe(1);
      expect(m.root.level).toBe("system");
      expect(m.stats.files).toBeGreaterThan(50);

      // The monorepo's workspace packages show up as modules.
      const moduleNames = m.root.children.map((c) => c.name);
      expect(moduleNames).toContain("@sivru/cli");
      expect(moduleNames).toContain("@sivru/search");

      // The model fuses @sivru blocks — at least one symbol carries one.
      const withBlock = collect(m.root).filter((n) => n.block !== null);
      expect(withBlock.length).toBeGreaterThan(0);

      // Every node id is unique and route-able (slices 2/3 depend on this).
      const ids = collect(m.root).map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
    60_000,
  );
});

describe("projectModel — cache short-circuit", () => {
  let repo: string;
  let cacheDir: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sivru-pm-repo-"));
    cacheDir = mkdtempSync(join(tmpdir(), "sivru-pm-cache-"));
    execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function sentinel(stateId: string): ExplainerModel {
    return {
      schema: 1,
      repoPath: resolve(repo),
      stateId,
      root: {
        id: "system",
        level: "system",
        name: "SENTINEL", // a build would never produce this name for an empty repo
        path: "",
        children: [],
        derived: { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] },
        block: null,
      },
      stats: { files: 0, symbols: 0, modules: 0 },
    };
  }

  it.runIf(gitWorks())(
    "returns a cached model on a stateId hit without rebuilding",
    async () => {
      // Pre-seed the cache at the repo's REAL stateId with a recognizable model.
      const stateId = await computeStateId(repo);
      await saveModelCache(sentinel(stateId), cacheDir);

      const got = await projectModel(repo, { cacheDir });
      expect(got.root.name).toBe("SENTINEL"); // came from cache, not a rebuild

      // noCache bypasses the cache and rebuilds (no SENTINEL).
      const fresh = await projectModel(repo, { cacheDir, noCache: true });
      expect(fresh.root.name).not.toBe("SENTINEL");
    },
    30_000,
  );
});
