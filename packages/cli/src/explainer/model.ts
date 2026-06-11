// Codebase-explainer model builder (DESIGN-0018 Slice 1).
//
// Builds the four-level ExplainerNode tree from sivru's existing machinery —
// ONE symbol-index pass + the index's batched churn + per-file @sivru block
// extraction. NO per-file `assembleArtifact` loop (that would be ~one git
// invocation per file and blow the <10s-on-2000-files gate; the index entry
// already carries exports, resolved imports, and commitCount).
//
//   System ─┬─► Module ─┬─► Package ─┬─► Symbol
//   (repo)  │  (pkg dir) │  (src sub) │  (export / @sivru block)
//           │            │            └ block: fused @sivru block
//           │            └ depEdges: packages it imports from
//           └ narrative + churn (summed over DISTINCT files, never per-symbol)
//
// Build path (real): computeStateId → buildCommitCounts → loadOrBuildSymbolIndex
//   → index.entries() → group by (module, package) → fuse blocks → aggregate up.
// Every external is injectable via `deps` so the whole builder unit-tests with
// an in-memory index and no git / filesystem.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildCommitCounts,
  computeStateId,
  extractBlocks,
  extractImportSpecifier,
  blockToJSON,
  hashBlockContent,
  loadOrBuildSymbolIndex,
  type SymbolIndex,
} from "@sivru/search";

import { mapWithConcurrency } from "../lib/concurrency.js";
import { gitHeadShort } from "../lib/git.js";
import { moduleDirOf, packageSegOf } from "./levels.js";
import { loadModelCache, saveModelCache } from "./model-cache.js";
import { resolveNarrative, type NarrativeDeps } from "./narrative.js";
import type {
  ExplainerDerived,
  ExplainerModel,
  ExplainerNode,
} from "./types.js";

/** One extracted block, normalized for the builder (wire-shape JSON or null). */
export interface ExtractedForFile {
  kind: string;
  symbolName?: string;
  blockJSON: object | null;
  /** hashBlockContent of the parsed block (staleness key for Slice 3). */
  blockHash?: string;
}

export interface BuildModelDeps {
  /** Inject a prebuilt index (tests) — skips computeStateId/git/index build. */
  index?: SymbolIndex;
  /** state_id to stamp the model with when an index is injected. */
  stateId?: string;
  /** Short git HEAD to stamp (tests); default reads `git rev-parse --short HEAD`. */
  head?: string;
  /** Repo-relative POSIX dirs that contain a package.json (the module roots). */
  packageDirs?: string[];
  /** Display name for a module dir (default: read package.json "name"). */
  packageName?: (repoRoot: string, moduleDir: string) => Promise<string>;
  /** Extract `@sivru` blocks for one repo-relative file. */
  extractFor?: (repoRoot: string, relPath: string) => Promise<ExtractedForFile[]>;
  /** Narrative resolution (system node). */
  narrative?: NarrativeDeps;
}

// ── filesystem helpers (all injectable above) ───────────────────────────────

/** Repo-relative POSIX dirs containing a package.json, excluding node_modules. */
async function discoverPackageDirs(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(resolve(repoRoot, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "package.json")) {
      out.push(relDir);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const child = relDir === "" ? e.name : `${relDir}/${e.name}`;
      await walk(child);
    }
  };
  await walk("");
  return out;
}

async function defaultPackageName(
  repoRoot: string,
  moduleDir: string,
): Promise<string> {
  try {
    const raw = await readFile(
      resolve(repoRoot, moduleDir === "" ? "package.json" : `${moduleDir}/package.json`),
      "utf8",
    );
    const name = (JSON.parse(raw) as { name?: string }).name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    // fall through to basename
  }
  if (moduleDir === "") return ".";
  return moduleDir.split("/").pop() ?? moduleDir;
}

async function defaultExtractFor(
  repoRoot: string,
  relPath: string,
): Promise<ExtractedForFile[]> {
  try {
    // Perf: read once and skip the tree-sitter parse on the vast majority of
    // files that carry no `@sivru` fence. On a 412-file repo this is the
    // difference between ~7s and ~1s — extractBlocks parses unconditionally.
    const content = await readFile(resolve(repoRoot, relPath), "utf8");
    if (!content.includes("@sivru")) return [];
    const extracted = await extractBlocks(resolve(repoRoot, relPath), { content });
    return extracted.map((eb) => ({
      kind: eb.kind,
      ...(eb.symbolName !== undefined ? { symbolName: eb.symbolName } : {}),
      blockJSON: eb.block === null ? null : blockToJSON(eb.block),
      ...(eb.block === null ? {} : { blockHash: hashBlockContent(eb.block) }),
    }));
  } catch {
    return [];
  }
}

// ── id + small helpers ───────────────────────────────────────────────────────

const moduleId = (dir: string): string => `module:${dir === "" ? "." : dir}`;
const packageId = (dir: string, seg: string): string =>
  `package:${dir === "" ? "." : dir}/${seg}`;
const symbolId = (file: string, name: string): string => `symbol:${file}#${name}`;
const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

function emptyDerived(): ExplainerDerived {
  return { exports: [], importsResolved: [], churn: 0, depEdges: [], collaborators: [] };
}

function resolvedImports(e: {
  imports: ReadonlyArray<{ resolved: string | null }>;
}): string[] {
  return uniq(e.imports.map((i) => i.resolved).filter((r): r is string => r !== null));
}

function blockCollaborators(block: object | null): string[] {
  if (block === null) return [];
  const c = (block as { collaborators?: unknown }).collaborators;
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === "string") : [];
}

function addTo(m: Map<string, Set<string>>, key: string, value: string): void {
  let s = m.get(key);
  if (s === undefined) m.set(key, (s = new Set()));
  s.add(value);
}

/** Union exports + importsResolved from a node's direct children (NOT churn). */
function rollUpExports(node: ExplainerNode): void {
  const exports = new Set(node.derived.exports);
  const imports = new Set(node.derived.importsResolved);
  for (const child of node.children) {
    for (const x of child.derived.exports) exports.add(x);
    for (const i of child.derived.importsResolved) imports.add(i);
  }
  node.derived.exports = [...exports].sort();
  node.derived.importsResolved = [...imports].sort();
}

// ── public entry: cache-aware projection ─────────────────────────────────────

export interface ProjectModelOptions {
  /** Override the cache directory (tests). */
  cacheDir?: string;
  /** Bypass the model cache entirely (always rebuild, don't write). */
  noCache?: boolean;
}

/**
 * Cache-aware whole-repo projection — what `sivru explain --project` calls.
 * `computeStateId` once, return a cached model on a stateId hit, otherwise
 * build and write through. A stateId hit is always valid: the model is a pure
 * function of repo state, and any change moves the stateId.
 */
export async function projectModel(
  repoRoot: string,
  options: ProjectModelOptions = {},
): Promise<ExplainerModel> {
  const abs = resolve(repoRoot);
  const stateId = await computeStateId(abs);
  if (options.noCache !== true) {
    const cached = await loadModelCache(abs, stateId, options.cacheDir);
    if (cached !== null) return cached;
  }
  const model = await buildExplainerModel(abs, { stateId });
  if (options.noCache !== true) await saveModelCache(model, options.cacheDir);
  return model;
}

// ── builder ──────────────────────────────────────────────────────────────────

/**
 * Build the explainer model for a repo. Pure assembly over the symbol index —
 * see the file header for the perf rationale. `projectModel` wraps this with
 * the stateId cache.
 *
 * @sivru
 * schema: 1
 * role: explainer-model-builder
 * responsibility: project a repo into the four-level ExplainerNode model (System → Module → Package → Symbol), fusing index-derived facts with @sivru blocks
 * collaborators: [loadOrBuildSymbolIndex, buildCommitCounts, extractBlocks, moduleDirOf, projectModel]
 * invariants:
 *   - rule: "churn aggregates over distinct files, never summed per-symbol"
 *     enforced-by: model.test.ts
 *   - rule: "no per-file assembleArtifact — built from one index pass + batched churn to hold the perf budget"
 *     enforced-by: null
 * decisions:
 *   - chose: build from the symbol index + batched churn rather than looping explain per file
 *     because: per-file assembleArtifact is ~one git invocation per file and blows the <10s-on-2000-files gate
 *     valid-while: the index entry carries exports, resolved imports, and commitCount
 *     revisit-if: the model needs per-file deep facts (callers, ownership) the index does not hold
 * maturity: experimental
 * @end
 */
export async function buildExplainerModel(
  repoRoot: string,
  deps: BuildModelDeps = {},
): Promise<ExplainerModel> {
  const abs = resolve(repoRoot);
  const packageName = deps.packageName ?? defaultPackageName;
  const extractFor = deps.extractFor ?? defaultExtractFor;

  // 1. Index + stateId (reuse the explain machinery; cache-keyed on repo state).
  let index: SymbolIndex;
  let stateId: string;
  if (deps.index !== undefined) {
    index = deps.index;
    stateId = deps.stateId ?? index.stateId;
  } else {
    stateId = deps.stateId ?? (await computeStateId(abs));
    // Churn is best-effort: a brand-new repo with no commits makes `git log`
    // fail, and a non-git tree returns empty. Either way the model should
    // build with churn 0 rather than crash — `--project` must work on a fresh
    // `git init` repo, where `explain <file>` itself would throw.
    let commitCounts: Map<string, number>;
    try {
      commitCounts = await buildCommitCounts(abs);
    } catch {
      commitCounts = new Map();
    }
    index = (await loadOrBuildSymbolIndex(abs, stateId, { commitCounts })).index;
  }

  const pkgDirs = deps.packageDirs ?? (await discoverPackageDirs(abs));
  const entries = index.entries();

  // Resolve module display names once, and invert to a name → module-id map so
  // cross-package imports (`@sivru/search`, which the relative resolver leaves
  // unresolved) still produce module-level dependency edges.
  const moduleNameByDir = new Map<string, string>();
  const moduleIdByName = new Map<string, string>();
  for (const dir of new Set<string>([...pkgDirs, ""])) {
    const name = await packageName(abs, dir);
    moduleNameByDir.set(dir, name);
    if (dir !== "") moduleIdByName.set(name, moduleId(dir));
  }

  // 2. Map every file to its (moduleDir, packageId) once.
  const fileModuleDir = new Map<string, string>();
  const filePackageId = new Map<string, string>();
  for (const e of entries) {
    const mDir = moduleDirOf(e.filePath, pkgDirs);
    fileModuleDir.set(e.filePath, mDir);
    filePackageId.set(e.filePath, packageId(mDir, packageSegOf(e.filePath, mDir)));
  }

  // 3. Build leaf symbol nodes, grouped into module → package buckets, fusing
  //    @sivru blocks. Churn is tracked per DISTINCT file per node (never summed
  //    per-symbol, which would multiply a file's churn by its symbol count).
  interface Bucket {
    node: ExplainerNode;
    pkgBySeg: Map<string, ExplainerNode>;
  }
  const moduleBuckets = new Map<string, Bucket>();
  const pkgFileChurn = new Map<string, Map<string, number>>(); // pkgId -> file -> churn
  const modFileChurn = new Map<string, Map<string, number>>(); // modId -> file -> churn
  const sysFileChurn = new Map<string, number>();
  let symbolCount = 0;

  const ensureModule = async (mDir: string): Promise<Bucket> => {
    const id = moduleId(mDir);
    let b = moduleBuckets.get(id);
    if (b === undefined) {
      b = {
        node: {
          id,
          level: "module",
          name: moduleNameByDir.get(mDir) ?? mDir,
          path: mDir,
          children: [],
          derived: emptyDerived(),
          block: null,
        },
        pkgBySeg: new Map(),
      };
      moduleBuckets.set(id, b);
    }
    return b;
  };

  const ensurePackage = (b: Bucket, mDir: string, seg: string): ExplainerNode => {
    let pkg = b.pkgBySeg.get(seg);
    if (pkg === undefined) {
      pkg = {
        id: packageId(mDir, seg),
        level: "package",
        name: seg,
        path: mDir === "" ? (seg === "(root)" ? "" : seg) : `${mDir}/${seg}`,
        children: [],
        derived: emptyDerived(),
        block: null,
      };
      b.pkgBySeg.set(seg, pkg);
      b.node.children.push(pkg);
    }
    return pkg;
  };

  // Prefetch every file's @sivru blocks with bounded concurrency — the file
  // reads/parses are independent and are the model build's main I/O cost
  // (the substring gate skips the parse on most files). Tree mutation below
  // stays SEQUENTIAL so the shared module/package maps see no races.
  const blocksByFile = new Map<string, ExtractedForFile[]>();
  const prefetched = await mapWithConcurrency(entries, 16, (e) =>
    extractFor(abs, e.filePath),
  );
  entries.forEach((e, i) => blocksByFile.set(e.filePath, prefetched[i]!));

  for (const e of entries) {
    const blocks = blocksByFile.get(e.filePath)!;
    const symbolBlock = new Map<string, ExtractedForFile>();
    let moduleBlock: ExtractedForFile | null = null;
    for (const blk of blocks) {
      if (blk.blockJSON === null) continue;
      if (blk.kind === "module") moduleBlock = blk;
      else if (blk.symbolName !== undefined) symbolBlock.set(blk.symbolName, blk);
    }

    const names = new Set<string>(e.exports.map((x) => x.name));
    for (const n of symbolBlock.keys()) names.add(n);
    if (names.size === 0 && moduleBlock === null) continue; // not load-bearing

    const mDir = fileModuleDir.get(e.filePath)!;
    const seg = packageSegOf(e.filePath, mDir);
    const bucket = await ensureModule(mDir);
    const pkg = ensurePackage(bucket, mDir, seg);

    // Record this file's churn once per node it contributes to.
    setFileChurn(pkgFileChurn, pkg.id, e.filePath, e.commitCount);
    setFileChurn(modFileChurn, bucket.node.id, e.filePath, e.commitCount);
    sysFileChurn.set(e.filePath, e.commitCount);

    // `importCallees` is FILE-level (every name the file imports), so all
    // symbols in a file share it — the index has no per-symbol import usage.
    // Slice 2 should treat collaborators as file-granular, not per-symbol truth.
    const importCallees = uniq(e.imports.flatMap((imp) => imp.identifiers));
    const imports = resolvedImports(e);

    const addSymbol = (name: string, entry: ExtractedForFile | null, display: string): void => {
      const block = entry?.blockJSON ?? null;
      const declLine = e.exports.find((x) => x.name === name)?.startLine;
      pkg.children.push({
        id: symbolId(e.filePath, name),
        level: "symbol",
        name: display,
        path: e.filePath,
        children: [],
        derived: {
          exports: e.exports.some((x) => x.name === name) ? [name] : [],
          importsResolved: imports,
          churn: e.commitCount,
          depEdges: [],
          collaborators: uniq([...importCallees, ...blockCollaborators(block)]),
        },
        block: block as ExplainerNode["block"],
        ...(entry?.blockHash !== undefined ? { blockHash: entry.blockHash } : {}),
        ...(declLine !== undefined ? { declLine } : {}),
      });
      symbolCount++;
    };

    for (const name of names) addSymbol(name, symbolBlock.get(name) ?? null, name);
    if (moduleBlock !== null) {
      const base = e.filePath.split("/").pop() ?? e.filePath;
      addSymbol("(module)", moduleBlock, `(module) ${base}`);
    }
  }

  // 4. Dependency edges from resolved imports (no self-edges, deduped).
  const moduleDeps = new Map<string, Set<string>>();
  const packageDeps = new Map<string, Set<string>>();
  for (const e of entries) {
    const fromMod = moduleId(fileModuleDir.get(e.filePath)!);
    const fromPkg = filePackageId.get(e.filePath)!;
    for (const imp of e.imports) {
      if (imp.resolved === null) {
        // Cross-package import (`@sivru/search`): not file-resolvable, but its
        // specifier may name a workspace package → a module-level dep edge.
        const spec = extractImportSpecifier(imp.raw);
        const toMod = spec === null ? null : moduleIdForSpecifier(spec, moduleIdByName);
        if (toMod !== null && toMod !== fromMod) addTo(moduleDeps, fromMod, toMod);
        continue;
      }
      const toMod = fileModuleDir.has(imp.resolved)
        ? moduleId(fileModuleDir.get(imp.resolved)!)
        : null;
      const toPkg = filePackageId.get(imp.resolved) ?? null;
      if (toMod !== null && toMod !== fromMod) addTo(moduleDeps, fromMod, toMod);
      if (toPkg !== null && toPkg !== fromPkg) addTo(packageDeps, fromPkg, toPkg);
    }
  }

  // 5. Aggregate: distinct-file churn + unioned exports + attach dep edges.
  const modules: ExplainerNode[] = [];
  for (const { node } of moduleBuckets.values()) {
    for (const pkg of node.children) {
      pkg.derived.churn = sumValues(pkgFileChurn.get(pkg.id));
      rollUpExports(pkg);
      pkg.derived.depEdges = [...(packageDeps.get(pkg.id) ?? [])].sort();
    }
    node.derived.churn = sumValues(modFileChurn.get(node.id));
    rollUpExports(node);
    node.derived.depEdges = [...(moduleDeps.get(node.id) ?? [])].sort();
    modules.push(node);
  }
  modules.sort((a, b) => a.path.localeCompare(b.path));

  const narrative = (await resolveNarrative(abs, deps.narrative)).text;
  const root: ExplainerNode = {
    id: "system",
    level: "system",
    name: moduleNameByDir.get("") ?? ".",
    path: "",
    children: modules,
    derived: emptyDerived(),
    block: null,
    narrative,
  };
  root.derived.churn = sumValues(sysFileChurn);
  rollUpExports(root);

  return {
    schema: 1,
    repoPath: abs,
    stateId,
    head: deps.head ?? (await gitHeadShort(abs)),
    root,
    stats: { files: entries.length, symbols: symbolCount, modules: modules.length },
  };
}

function setFileChurn(
  m: Map<string, Map<string, number>>,
  nodeId: string,
  file: string,
  churn: number,
): void {
  let inner = m.get(nodeId);
  if (inner === undefined) m.set(nodeId, (inner = new Map()));
  inner.set(file, churn); // last write wins; same file → same churn, idempotent
}

function sumValues(m: Map<string, number> | undefined): number {
  if (m === undefined) return 0;
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/**
 * Map an import specifier to a workspace module id. Exact package-name match
 * first (`@sivru/search`), then the longest package-name prefix for subpath
 * imports (`@sivru/search/block` → the search module).
 */
function moduleIdForSpecifier(
  spec: string,
  byName: Map<string, string>,
): string | null {
  const exact = byName.get(spec);
  if (exact !== undefined) return exact;
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, id] of byName) {
    if (spec.startsWith(name + "/") && name.length > bestLen) {
      best = id;
      bestLen = name.length;
    }
  }
  return best;
}
