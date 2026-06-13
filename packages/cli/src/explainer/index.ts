// Public surface of the codebase explainer (DESIGN-0018).
//
// Slice 1: the model + `--project` JSON. Slice 2: `--html` (the self-contained
// projection). Slice 3 (feedback) adds without reshaping the model contract.

export { buildExplainerModel, projectModel } from "./model.js";
export { renderHtml } from "./html/render.js";
export { selfVerify } from "./html/routes.js";
export type {
  BuildModelDeps,
  ExtractedForFile,
  ProjectModelOptions,
} from "./model.js";
export { loadModelCache, saveModelCache } from "./model-cache.js";
export { resolveNarrative } from "./narrative.js";
export type { NarrativeOrigin, ResolvedNarrative } from "./narrative.js";
export { moduleDirOf, packageSegOf } from "./levels.js";
// DESIGN-0023: the architectural diff.
export { diffModels } from "./diff.js";
export { buildBaseModel } from "./diff-worktree.js";
export type { BaseModelResult, DiffWorktreeDeps } from "./diff-worktree.js";
export { formatDelta, formatDeltaText, formatDeltaJson, formatDeltaGithub, isEmptyDelta } from "./diff-format.js";
export type { DeltaFormat } from "./diff-format.js";
export { buildDepGraph, findCycleGroups, newCycles } from "./cycles.js";
export type { ArchDelta, CycleDelta, DepEdge, NodeRef, ChangedNode, ChurnDelta } from "./diff-types.js";
export type {
  ExplainerLevel,
  ExplainerDerived,
  ExplainerNode,
  ExplainerModel,
} from "./types.js";
