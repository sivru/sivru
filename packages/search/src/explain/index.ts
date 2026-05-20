// Public surface of `@sivru/search`'s explain module (DESIGN-0004 §6 / T1).
//
// v0.5 is built incrementally; this file lists every public surface in the
// module so downstream callers (CLI in T9, MCP in T10) can import from one
// stable path. As tasks land, new exports are added here.

export type {
  AuthoredEntry,
  CalleeRef,
  CallerRef,
  ChurnInfo,
  Export,
  ExportKind,
  ExplainArtifact,
  ExplainEnvelope,
  ExplainErrorCode,
  ExplainOptions,
  ImportEdge,
  OwnershipEntry,
  RemovedSymbolReport,
  Resolver,
  SymbolIndex,
  SymbolIndexEntry,
  TestHit,
} from "./types.js";

export { SivruExplainError } from "./types.js";

export {
  parsePathAndSymbol,
  resolveAndAssertInside,
  validateRelPathSyntax,
} from "./path-validator.js";

export { createParseCache } from "./parse-cache.js";
export type { ParseCache } from "./parse-cache.js";

export { resolverFor, supportedLanguages } from "./resolvers/index.js";
export {
  typescriptResolver,
  extractImportedIdentifiers,
  extractImportSpecifier,
} from "./resolvers/typescript.js";
export {
  pythonResolver,
  parseFromSpec,
  parseImportSpec,
} from "./resolvers/python.js";

export {
  buildSymbolIndex,
  refreshSymbolIndex,
  parseOneFile,
} from "./symbol-index.js";
export type {
  BuildSymbolIndexOptions,
  RefreshDelta,
} from "./symbol-index.js";
