// Baseline harness for the `map` MCP tool / `sivru map` CLI (DESIGN-0024).
//
// Runs map against a real, substantial repository (default: the buildwrightV2 QA
// corpus) and emits a baseline report: model size, cold/warm latencies, per-call
// slice latency (the design's "sub-10ms warm" claim), repo-wide health-signal
// coverage, and contract snapshots for the five entry shapes (symbol / file /
// task / did-you-mean / error). Re-run to diff against a saved baseline.
//
//   node packages/cli/scripts/map-baseline.mjs [--repo <path>] [--out <file>] [--cold]
//
// --cold clears the model+health caches first (model-projection cold; the symbol
// index cache is left intact unless you also clear ~/.cache/sivru/index*).

import { performance } from "node:perf_hooks";
import { rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { loadModelAndHealth } from "../dist/explainer/map-serve.js";
import { mapByPath, mapByTask, resolveTarget } from "../dist/explainer/agent-map.js";
import { HOT_RANK_LIMIT } from "../dist/explainer/health.js";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const REPO = resolve(arg("--repo", "/Users/pochadri/dev/10xdelta/buildwrightV2"));
const OUT = arg("--out", null);
const COLD = process.argv.includes("--cold");

const ms = (n) => Math.round(n * 10) / 10;
async function timed(fn) {
  const t = performance.now();
  const v = await fn();
  return [ms(performance.now() - t), v];
}

if (COLD) {
  rmSync(join(homedir(), ".cache", "sivru", "explainer-models"), { recursive: true, force: true });
  rmSync(join(homedir(), ".cache", "sivru", "explainer-health"), { recursive: true, force: true });
}

// 1. Load (cold or warm depending on cache state) — builds/serves model + health.
const [loadMs, served] = await timed(() => loadModelAndHealth(REPO));
const { model, health, freshAsOf } = served;

// 2. Warm reload — should be a cache hit (model + health both cached).
const [warmLoadMs] = await timed(() => loadModelAndHealth(REPO));

// 3. Repo-wide health-signal coverage (off the cached health).
let hot = 0, inCycle = 0, driftBroken = 0, unguardable = 0;
for (const h of Object.values(health.byId)) {
  if (h.hot) hot++;
  if (h.inCycle) inCycle++;
  if (h.driftBroken.length) driftBroken++;
  if (h.unguardable.length) unguardable++;
}

// 4. Pick representative real targets from the model.
const allNodes = [];
(function walk(n) { if (n.level !== "system") allNodes.push(n); n.children.forEach(walk); })(model.root);
const aSymbol = allNodes.find((n) => n.level === "symbol" && health.byId[n.id]?.hot) // a hot symbol if any
  ?? allNodes.find((n) => n.level === "symbol");
const aFile = aSymbol ? aSymbol.path : null;
const aHotModule = Object.entries(health.byId).find(([id, h]) => h.hot && id.startsWith("module:"));

// 5. Per-call slice latency over 20 random-ish symbol targets (the warm hot path).
const sampleSyms = allNodes.filter((n) => n.level === "symbol").filter((_, i) => i % Math.max(1, Math.floor(allNodes.length / 400)) === 0).slice(0, 20);
const perCall = [];
for (const s of sampleSyms) {
  const [t] = await timed(async () => mapByPath(model, health, s.path, s.name));
  perCall.push(t);
}
perCall.sort((a, b) => a - b);
const p50 = perCall[Math.floor(perCall.length * 0.5)] ?? null;
const p95 = perCall[Math.floor(perCall.length * 0.95)] ?? null;

// 6. Contract snapshots for the five entry shapes.
function snap(label, result) {
  const base = { label, kind: result.kind };
  if (result.kind === "slice") {
    return { ...base, target: `${result.target.level}:${result.target.name}`, module: result.module?.name ?? null,
      dependsOn: result.dependsOn.length, dependedOnBy: result.dependedOnBy.length,
      collaborators: result.collaborators.length, health: {
        hot: !!result.health.hot, inCycle: !!result.health.inCycle,
        driftBroken: result.health.driftBroken.length, unguardable: result.health.unguardable.length },
      authoring: !!result.authoring, truncated: result.truncated ?? null };
  }
  if (result.kind === "candidates") return { ...base, candidates: result.candidates.length, top: result.candidates[0]?.ref?.name ?? null };
  return { ...base, error: result.error, candidates: result.candidates?.length ?? 0 };
}

const symbolCase = aSymbol ? snap("symbol", mapByPath(model, health, aSymbol.path, aSymbol.name)) : { label: "symbol", kind: "n/a" };
const fileCase = aFile ? snap("file-only", mapByPath(model, health, aFile)) : { label: "file-only", kind: "n/a" };
const taskCase = snap("task", mapByTask(model, "session token validation"));
const typoCase = aSymbol ? snap("did-you-mean", mapByPath(model, health, aSymbol.path, aSymbol.name + "ZZZ")) : { label: "did-you-mean", kind: "n/a" };
const missCase = snap("error-nopath", mapByPath(model, health, "no/such/dir/nope.xyz"));

const report = {
  tool: "map-baseline",
  schema: 1,
  repo: { path: REPO, head: model.head, dirtyServed: freshAsOf.dirty, stateId: model.stateId },
  model: { files: model.stats.files, symbols: model.stats.symbols, modules: model.stats.modules, totalNodes: allNodes.length },
  latency_ms: { load_cold_or_warm: loadMs, load_warm_reload: warmLoadMs, slice_p50: p50, slice_p95: p95, slice_n: perCall.length, cold: COLD },
  health_coverage: { hotRankLimit: HOT_RANK_LIMIT, nodesWithHot: hot, nodesInCycle: inCycle, nodesDriftBroken: driftBroken, nodesUnguardable: unguardable, totalSignalNodes: Object.keys(health.byId).length },
  freshAsOf,
  contract_snapshots: [symbolCase, fileCase, taskCase, typoCase, missCase],
};

const json = JSON.stringify(report, null, 2);
if (OUT) { writeFileSync(OUT, json + "\n"); process.stderr.write(`wrote ${OUT}\n`); }
process.stdout.write(json + "\n");
