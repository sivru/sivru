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
  SivruDecision,
  SivruDecisionJSON,
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
  RUNAWAY_LINES,
  loadBlockConfig,
} from "./config.js";
