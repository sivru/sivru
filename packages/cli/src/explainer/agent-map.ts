// The agent's working map (DESIGN-0024). A PURE projection of the already-built
// ExplainerModel + its cached health into the slice an agent reads before it edits
// a symbol: the target's authored intent, its module + 1-hop neighbourhood (the
// blast radius), its symbol-level collaborators, and its descriptive M-A health.
//
// No I/O, no LLM, no network: model + health in, slice out. The mcp-entry / CLI
// layers own the cache, serve-stale, and freshAsOf concerns (DESIGN-0024 T6); this
// module is deterministic and unit-testable with an injected model + health.
//
// Every result carries a `kind` discriminator (slice | candidates | error) so the
// agent branches on one field instead of duck-typing on key presence (DX review).

import type { NodeRef } from "./diff-types.js";
import { healthOf, type ModelHealth, type NodeHealth } from "./health.js";
import type { ExplainerModel, ExplainerNode } from "./types.js";

// Stable error codes for the map contract (CLAUDE.md: every error gets a
// SIVRU-ENNN code; codes are stable, never renumbered).
/** A `path` target did not resolve to a node (did-you-mean candidates follow). */
export const MAP_ERR_NO_TARGET = "SIVRU-E249";
/** Neither `path` nor `task` was supplied. */
export const MAP_ERR_MISSING_ARGS = "SIVRU-E250";
/** An unexpected failure while building the slice. */
export const MAP_ERR_FAILED = "SIVRU-E251";

/** Default neighbour/collaborator cap before "+N more" overflow (DESIGN-0024). */
export const MAP_NEIGHBOR_CAP = 12;
/** Default number of task / did-you-mean candidates returned. */
export const MAP_CANDIDATE_LIMIT = 5;
/** Below this lexical score a candidate is noise, not a suggestion. */
export const MAP_CANDIDATE_FLOOR = 0.3;

export interface Candidate {
  ref: NodeRef;
  score: number;
}

export interface MapModuleInfo {
  name: string;
  role?: string;
  responsibility?: string;
  churn: number;
  hotScore?: number;
  /** 1-indexed rank in the repo attention list, when the module is hot. */
  rank?: number;
}

export interface MapSlice {
  kind: "slice";
  target: { id: string; level: string; name: string; path: string; block?: unknown; declLine?: number };
  module: MapModuleInfo | null;
  dependsOn: NodeRef[];
  dependedOnBy: NodeRef[];
  collaborators: string[];
  health: NodeHealth;
  /** Present ONLY when the target carries no `@sivru` block — surfaces the gap. */
  authoring?: { stubHint: string };
  /** Counts dropped by the cap; a field is present only when > 0. */
  truncated?: { dependsOn?: number; dependedOnBy?: number; collaborators?: number };
}

export interface MapCandidates {
  kind: "candidates";
  candidates: Candidate[];
  /** Set when the list is empty (no clear target) — what was searched. */
  hint?: string;
}

export interface MapError {
  kind: "error";
  error: string;
  /** Did-you-mean: closest nodes to an unresolved path, never a bare dead end. */
  candidates?: Candidate[];
  hint?: string;
}

export type MapResult = MapSlice | MapCandidates | MapError;

const refOf = (n: ExplainerNode): NodeRef => ({ id: n.id, level: n.level, name: n.name, path: n.path });

// ── tree helpers ──────────────────────────────────────────────────────────────

/** A one-pass index of the model's nodes, shareable across a single map call. */
export interface Indexed {
  byId: Map<string, ExplainerNode>;
  all: ExplainerNode[];
  /** node id → its containing module node (model.root.children), or null. */
  moduleOf: Map<string, ExplainerNode>;
  /** node id → its direct parent node (package for a symbol, module for a package). */
  parentOf: Map<string, ExplainerNode>;
}

export function indexModel(model: ExplainerModel): Indexed {
  const byId = new Map<string, ExplainerNode>();
  const all: ExplainerNode[] = [];
  const moduleOf = new Map<string, ExplainerNode>();
  const parentOf = new Map<string, ExplainerNode>();
  for (const mod of model.root.children) {
    const mark = (n: ExplainerNode, parent: ExplainerNode): void => {
      byId.set(n.id, n);
      if (n.level !== "system") all.push(n);
      moduleOf.set(n.id, mod);
      parentOf.set(n.id, parent);
      n.children.forEach((c) => mark(c, n));
    };
    mark(mod, model.root);
  }
  byId.set(model.root.id, model.root);
  return { byId, all, moduleOf, parentOf };
}

/** Module id → ids of modules that depend on it (DESIGN-0024 T4, shared with --html). */
export function buildReverseDeps(model: ExplainerModel): Map<string, string[]> {
  const reverseDeps = new Map<string, string[]>();
  for (const mod of model.root.children) {
    for (const dep of mod.derived.depEdges) {
      const list = reverseDeps.get(dep) ?? reverseDeps.set(dep, []).get(dep)!;
      list.push(mod.id);
    }
  }
  return reverseDeps;
}

/** Strip a leading `./`, normalise separators, and split off a `::symbol` suffix. */
function normaliseTarget(rawPath: string, symbol: string | undefined): { filePath: string; symbol: string | undefined } {
  let p = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  let sym = symbol;
  const sep = p.indexOf("::");
  if (sep !== -1) {
    if (sym === undefined) sym = p.slice(sep + 2);
    p = p.slice(0, sep);
  }
  return { filePath: p, symbol: sym === undefined || sym.length === 0 ? undefined : sym };
}

/**
 * Resolve a `path` (+ optional `symbol`) to the node `map` should orient on.
 * A symbol target resolves to its symbol node; a file-only target resolves to
 * the deepest containing package/module node (symbol-less file → module/package
 * slice, DESIGN-0024). Returns null when nothing resolves (→ did-you-mean).
 */
export function resolveTarget(
  model: ExplainerModel,
  rawPath: string,
  symbol?: string,
  index?: Indexed,
): ExplainerNode | null {
  const { byId, all, parentOf } = index ?? indexModel(model);
  const { filePath, symbol: sym } = normaliseTarget(rawPath, symbol);
  if (filePath.length === 0) return null;

  if (sym !== undefined) {
    const direct = byId.get(`symbol:${filePath}#${sym}`);
    if (direct !== undefined) return direct;
    const match = all.find(
      (n) => n.level === "symbol" && n.path === filePath && (n.name === sym || n.derived.exports.includes(sym)),
    );
    return match ?? null;
  }

  // File-only → the package that OWNS the file's symbols. Symbol nodes carry the
  // real file path, but package node paths drop the `src/` segment (levels.ts),
  // so a path-prefix match against package paths would miss; the symbol's parent
  // is authoritative and works for single-package repos (module path "") too.
  const owning = all.find((n) => n.level === "symbol" && n.path === filePath);
  if (owning !== undefined) return parentOf.get(owning.id) ?? owning;

  // No load-bearing symbol at that path (a directory, or a symbol-less file):
  // fall back to the deepest module/package node whose path prefixes the file.
  const levelRank = (n: ExplainerNode): number => (n.level === "package" ? 2 : n.level === "module" ? 1 : 0);
  let best: ExplainerNode | null = null;
  for (const n of all) {
    if (n.level !== "module" && n.level !== "package") continue;
    if (n.path === "") continue;
    const hit = filePath === n.path || filePath.startsWith(`${n.path}/`);
    if (!hit) continue;
    if (
      best === null ||
      n.path.length > best.path.length ||
      (n.path.length === best.path.length && levelRank(n) > levelRank(best))
    ) {
      best = n;
    }
  }
  return best;
}

// ── candidate ranking (lexical, deterministic — DESIGN-0024 Slice 1) ───────────
//
// Slice 1 ranks candidates by lexical token overlap over a node's name/path/id —
// deterministic, fast, no embedder on the hot path. Semantic ranking is a future
// upgrade (a2 in the run journal). Used for both `task` entry and did-you-mean.

function tokenise(s: string): string[] {
  // Split camelCase BEFORE lowercasing so `doThing` → [do, thing], not one blob.
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// Filler words a free-text TASK query carries that no code identifier matches.
// Dropping them from the query (not the haystack) keeps the denominator honest,
// so "where dependency cycles are detected" scores on "dependency"/"cycles", not
// diluted by "where"/"are". Lexical Slice-1 ranking; semantic is a future upgrade.
// Pure grammatical filler only — deliberately NOT code-ish words like do/get/set/
// find/handle, which appear in real identifiers (doThing, getUser, findCycleGroups).
const STOPWORDS = new Set([
  "where", "what", "which", "how", "the", "an", "is", "are", "was", "were", "be",
  "to", "of", "in", "on", "for", "and", "or", "does", "this", "that", "it", "we",
  "when", "with", "from", "by", "at", "as",
]);

/** Meaningful query tokens: camelCase-split, lowercased, stopwords + 1-char dropped. */
function queryTokensOf(query: string): string[] {
  return tokenise(query).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreNode(queryTokens: string[], queryRaw: string, node: ExplainerNode): number {
  if (queryTokens.length === 0) return 0;
  const hay = `${node.name} ${node.path} ${node.id}`.toLowerCase();
  const hayTokens = new Set(tokenise(hay));
  let hits = 0;
  for (const t of queryTokens) if (hayTokens.has(t) || hay.includes(t)) hits += 1;
  let score = hits / queryTokens.length;
  // Whole-query substring in the path is a strong signal (typo'd file path).
  if (queryRaw.length >= 3 && node.path.toLowerCase().includes(queryRaw.toLowerCase())) {
    score = Math.min(1, score + 0.25);
  }
  return score;
}

/**
 * Top-N nodes by lexical similarity to a free-text query (a task description or
 * an unresolved path string). Never returns the system root. Ties break by level
 * (symbol > package > module), then path length, then id, for determinism.
 */
export function rankCandidates(
  model: ExplainerModel,
  query: string,
  limit: number = MAP_CANDIDATE_LIMIT,
  floor: number = MAP_CANDIDATE_FLOOR,
): Candidate[] {
  const { all } = indexModel(model);
  const queryTokens = queryTokensOf(query);
  const queryRaw = query.trim().replace(/\\/g, "/");
  const levelRank = (lvl: string): number => (lvl === "symbol" ? 3 : lvl === "package" ? 2 : 1);
  return all
    .map((n) => ({ ref: refOf(n), score: scoreNode(queryTokens, queryRaw, n) }))
    .filter((c) => c.score >= floor)
    .sort(
      (a, b) =>
        b.score - a.score ||
        levelRank(b.ref.level) - levelRank(a.ref.level) ||
        a.ref.path.length - b.ref.path.length ||
        a.ref.id.localeCompare(b.ref.id),
    )
    .slice(0, limit);
}

// ── slice assembly ─────────────────────────────────────────────────────────────

function cap<T>(items: T[], limit: number): { kept: T[]; dropped: number } {
  return items.length <= limit ? { kept: items, dropped: 0 } : { kept: items.slice(0, limit), dropped: items.length - limit };
}

const STUB_HINT =
  "No `@sivru` block here. Authoring one (role / responsibility / invariants with " +
  "an enforced-by test) would let sivru guard this code's intent and surface drift " +
  "before an edit. map surfaces the gap; it never drafts the block for you.";

/**
 * Build the deterministic slice for a resolved target. `cap` bounds the neighbour
 * and collaborator lists; overflow is reported in `truncated` (DESIGN-0024 output
 * budget — a slice that floods the agent's context is a slice it stops calling).
 */
export function buildMapSlice(
  model: ExplainerModel,
  health: ModelHealth,
  target: ExplainerNode,
  opts: { neighborCap?: number; index?: Indexed } = {},
): MapSlice {
  const neighborCap = opts.neighborCap ?? MAP_NEIGHBOR_CAP;
  const { byId, moduleOf } = opts.index ?? indexModel(model);
  const reverseDeps = buildReverseDeps(model);
  const moduleNode = moduleOf.get(target.id) ?? null;

  const toRefs = (ids: string[]): NodeRef[] =>
    ids.map((id) => byId.get(id)).filter((n): n is ExplainerNode => n !== undefined).map(refOf);

  let moduleInfo: MapModuleInfo | null = null;
  const dependsOnRaw: NodeRef[] = [];
  const dependedOnByRaw: NodeRef[] = [];
  if (moduleNode !== null) {
    const block = moduleNode.block; // SivruBlockJSON | null — role/responsibility are typed strings
    const moduleHot = healthOf(health, moduleNode.id).hot;
    moduleInfo = {
      name: moduleNode.name,
      churn: moduleNode.derived.churn,
      ...(block !== null && block.role.length > 0 ? { role: block.role } : {}),
      ...(block !== null && block.responsibility.length > 0 ? { responsibility: block.responsibility } : {}),
      ...(moduleNode.derived.hotScore !== undefined ? { hotScore: moduleNode.derived.hotScore } : {}),
      ...(moduleHot !== null ? { rank: moduleHot.rank } : {}),
    };
    dependsOnRaw.push(...toRefs(moduleNode.derived.depEdges));
    dependedOnByRaw.push(...toRefs(reverseDeps.get(moduleNode.id) ?? []));
  }

  const dep = cap(dependsOnRaw, neighborCap);
  const rev = cap(dependedOnByRaw, neighborCap);
  const collabRaw = target.level === "symbol" ? target.derived.collaborators : [];
  const collab = cap(collabRaw, neighborCap);

  const truncated: { dependsOn?: number; dependedOnBy?: number; collaborators?: number } = {};
  if (dep.dropped > 0) truncated.dependsOn = dep.dropped;
  if (rev.dropped > 0) truncated.dependedOnBy = rev.dropped;
  if (collab.dropped > 0) truncated.collaborators = collab.dropped;

  const slice: MapSlice = {
    kind: "slice",
    target: {
      id: target.id,
      level: target.level,
      name: target.name,
      path: target.path,
      ...(target.block !== null ? { block: target.block } : {}),
      ...(target.declLine !== undefined ? { declLine: target.declLine } : {}),
    },
    module: moduleInfo,
    dependsOn: dep.kept,
    dependedOnBy: rev.kept,
    collaborators: collab.kept,
    health: healthOf(health, target.id),
    ...(target.block === null ? { authoring: { stubHint: STUB_HINT } } : {}),
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
  };
  return slice;
}

/**
 * Top-level: resolve a target-based map request to a slice, or a did-you-mean
 * error when the path does not resolve. Task-based entry is handled by the caller
 * via `rankCandidates` (it returns candidates first; the agent confirms).
 */
export function mapByPath(
  model: ExplainerModel,
  health: ModelHealth,
  rawPath: string,
  symbol?: string,
  opts: { neighborCap?: number } = {},
): MapSlice | MapError {
  // One index walk shared by resolution and slice assembly (the happy path).
  const index = indexModel(model);
  const target = resolveTarget(model, rawPath, symbol, index);
  if (target === null) {
    const candidates = rankCandidates(model, symbol !== undefined ? `${rawPath} ${symbol}` : rawPath);
    return {
      kind: "error",
      error: `${MAP_ERR_NO_TARGET}: no such target: ${symbol !== undefined ? `${rawPath}::${symbol}` : rawPath}`,
      ...(candidates.length > 0 ? { candidates, hint: "closest matches" } : { hint: "no close matches" }),
    };
  }
  return buildMapSlice(model, health, target, { ...opts, index });
}

/** Task-based entry: candidates first, the agent confirms (never auto-orient). */
export function mapByTask(model: ExplainerModel, task: string): MapCandidates {
  const candidates = rankCandidates(model, task);
  return candidates.length > 0
    ? { kind: "candidates", candidates }
    : { kind: "candidates", candidates: [], hint: `no clear target for: ${task}` };
}
