// Public surface of `@sivru/search`'s block module (DESIGN-0016 §7).
//
// Three primary entry points:
//   - `extractBlocks(path)`   → ExtractedBlock[]    (extract.ts)
//   - `validateBlock(block)`  → BlockDiagnostic[]   (validate.ts)
//   - `blockToJSON(block)`    → SivruBlockJSON      (toJSON.ts)
//
// All types live in `./types.js`; loaders / helpers re-exported below.

export type {
  BlockDiagnostic,
  BlockValidatorContext,
  CustomBlockValidator,
  ExtractedBlock,
  ExtractedBlockKind,
  SivruBlock,
  SivruBlockConfig,
  SivruBlockJSON,
  SivruBlockMaxLines,
  SivruDecision,
  SivruDecisionJSON,
  SivruInvariant,
  SivruInvariantJSON,
  SourceRange,
} from "./types.js";

export {
  extractBlocks,
  extractBlocksFromFiles,
  extractFences,
} from "./extract.js";
export type { ExtractBlocksOptions } from "./extract.js";

export { validateBlock, validateExtracted, hasErrors } from "./validate.js";

export { blockToJSON } from "./toJSON.js";

export {
  DEFAULT_BLOCK_CONFIG,
  DEFAULT_MAX_LINES,
  RUNAWAY_LINES,
  loadBlockConfig,
  resolveMaxLines,
} from "./config.js";

export { wrapYamlError } from "./yaml-errors.js";

export {
  checkEnforcement,
  parseEnforcedBy,
  resolveEnforcement,
} from "./enforcement.js";
export type { ParsedReference } from "./enforcement.js";

export { autofixFile, autofixFiles } from "./autofix.js";
export type { AutofixResult } from "./autofix.js";

export { closestMatch, levenshtein } from "./levenshtein.js";

export { staleBlocks } from "./staleness.js";
export type { StalenessOptions, StalenessReport } from "./staleness.js";

export { computeBlockGraph } from "./graph.js";
export type {
  BlockGraph,
  BlockGraphOptions,
  GraphEdge,
  GraphNode,
} from "./graph.js";

export { buildSymbolMap } from "./enforcement.js";
export type { EnforcementIndex } from "./enforcement.js";

export { buildBlockCache } from "./block-cache.js";
export type { BlockCache } from "./block-cache.js";
export type { BlockCacheEntry } from "../explain/types.js";

export { isBlockWalkSkippable } from "./walker-skip.js";

export { initBlock } from "./init.js";
export type { InitOptions, InitResult } from "./init.js";

export { checkBridges } from "./check-bridges.js";

export {
  JAVA_BRIDGES,
  resolveJavaBridges,
} from "./bridges/java.js";
export type { AnnotationBridge } from "./bridges/java.js";

export {
  PYTHON_BRIDGES,
  resolvePythonBridges,
} from "./bridges/python.js";

export { checkDeprecatedMaturitySync } from "./deprecated-sync.js";
