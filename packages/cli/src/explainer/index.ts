// Public surface of the codebase explainer (DESIGN-0018).
//
// Slice 1: the model + `--project` JSON. Slices 2 (`--html`) and 3 (feedback)
// add to this barrel without reshaping the ExplainerModel contract.

export { buildExplainerModel, projectModel } from "./model.js";
export type {
  BuildModelDeps,
  ExtractedForFile,
  ProjectModelOptions,
} from "./model.js";
export { loadModelCache, saveModelCache } from "./model-cache.js";
export { resolveNarrative } from "./narrative.js";
export type { NarrativeOrigin, ResolvedNarrative } from "./narrative.js";
export { moduleDirOf, packageSegOf } from "./levels.js";
export type {
  ExplainerLevel,
  ExplainerDerived,
  ExplainerNode,
  ExplainerModel,
} from "./types.js";
