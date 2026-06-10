// The codebase-explainer model (DESIGN-0018 Slice 1).
//
// This is the WIRE CONTRACT that slices 2 (HTML projection) and 3 (feedback)
// consume. It is one generic recursive node, typed by `level`, not four rigid
// per-level interfaces — so a monorepo (workspace packages + src subdirs) and a
// single-package repo (just src/) share one shape, and adding a level later is
// additive, not a breaking reshape.
//
//   System ──► Module ──► Package ──► Symbol
//   (repo)     (pkg dir)  (src subdir) (load-bearing export / @sivru block)
//
// Slice 1 fills the FULL structural data (depEdges, collaborators) even though
// it renders nothing, so the contract is locked once.

import type { SivruBlockJSON } from "@sivru/search";

export type ExplainerLevel = "system" | "module" | "package" | "symbol";

export interface ExplainerDerived {
  /**
   * Public API names. At symbol level, the symbol's own exported name; at
   * higher levels, the exported names aggregated from descendants (deduped).
   */
  exports: string[];
  /** Repo-relative POSIX import targets that resolved inside the repo. */
  importsResolved: string[];
  /** Commit count (churn) — summed from the index's per-file `commitCount`. */
  churn: number;
  /**
   * Dependency edges. At module/package level: the ids of the sibling
   * module/package nodes this one's files import from. Empty at symbol level.
   * (Self-edges and unresolved imports are excluded.)
   */
  depEdges: string[];
  /**
   * Symbol level only: `block.collaborators` unioned with the symbol file's
   * resolved import targets (the callees). Empty at higher levels.
   */
  collaborators: string[];
}

export interface ExplainerNode {
  /** Stable, route-able id, e.g. "module:packages/cli", "symbol:src/foo.ts#bar". */
  id: string;
  level: ExplainerLevel;
  /** Display name: package name, dir name, or symbol name. */
  name: string;
  /** Repo-relative POSIX path this node projects from (empty for system). */
  path: string;
  children: ExplainerNode[];
  derived: ExplainerDerived;
  /** The fused `@sivru` block, when the projected source carries one. */
  block: SivruBlockJSON | null;
  /** System level only: the narrative (repo docs / `.sivru/explainer.md` / stub). */
  narrative?: string;
}

export interface ExplainerModel {
  /** Wire-shape version. Bump on any breaking change to ExplainerNode. */
  schema: 1;
  /** Absolute repo root the model was built from. */
  repoPath: string;
  /** state_id the model was built under (drives the model cache). */
  stateId: string;
  /** The root system node; its children are the modules. */
  root: ExplainerNode;
  /** Build provenance, for the `--project` consumer and the perf gate. */
  stats: { files: number; symbols: number; modules: number };
}
