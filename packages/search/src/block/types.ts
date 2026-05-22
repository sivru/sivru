// Public types for the @sivru block module (DESIGN-0016 §1, §4, §5).
//
// The block carries authored context inside a host-language doc comment.
// Extraction reads source → ExtractedBlock[]; validation produces
// BlockDiagnostic[]; serialization to SivruBlockJSON is the wire shape
// consumed downstream (v0.7 DESIGN-0017 surfaces it through sivru.explain).
//
// Schema evolution (§5 A3): minor-additive changes stay at schema:1;
// breaking changes bump to schema:2. v0.6 strict-rejects schemas other
// than 1 (SIVRU-E214).

export type SivruDecision = {
  chose: string;
  because: string;
  // Hyphenated YAML-native field names are preserved in the parsed form;
  // toJSON.ts camelCases them for the JSON wire shape.
  "valid-while": string;
  "revisit-if"?: string;
};

export type SivruBlock = {
  schema: number;
  role: string;
  responsibility: string;
  collaborators?: string[];
  invariants?: string[];
  decisions?: SivruDecision[];
  maturity?: string;
};

export type SourceRange = {
  filePath: string;
  /** 1-indexed inclusive. */
  startLine: number;
  /** 1-indexed inclusive. */
  endLine: number;
};

export type BlockDiagnostic = {
  /** "SIVRU-E210" .. "SIVRU-E218" (v0.6 owns E210..E219). */
  code: string;
  severity: "error" | "warning";
  message: string;
  /**
   * Optional only for repo-wide diagnostics with no single source range.
   * Currently every v0.6 diagnostic carries a location; reserved for v0.7+
   * cross-file diagnostics.
   */
  location?: SourceRange;
};

export type ExtractedBlockKind = "symbol" | "module";

export type ExtractedBlock = {
  filePath: string;
  /** "symbol" for per-symbol blocks; "module" for top-of-file/package blocks. */
  kind: ExtractedBlockKind;
  /** Present only for kind:"symbol"; undefined for module-level. */
  symbolName?: string;
  range: SourceRange;
  /**
   * Parsed block when extraction + YAML parse succeeded, else null.
   * Per DESIGN-0016 §2: invalid blocks are NEVER silently dropped — they
   * appear with block:null and diagnostics populated.
   */
  block: SivruBlock | null;
  diagnostics: BlockDiagnostic[];
};

/** Canonical JSON wire shape (DESIGN-0016 §5). */
export type SivruDecisionJSON = {
  chose: string;
  because: string;
  validWhile: string;
  revisitIf: string | null;
};

export type SivruBlockJSON = {
  schema: number;
  role: string;
  responsibility: string;
  maturity: string | null;
  collaborators: string[];
  invariants: string[];
  decisions: SivruDecisionJSON[];
};

/** Config schema (DESIGN-0016 §6). Override-replaces-default for arrays. */
export type SivruBlockConfig = {
  requiredFields: string[];
  optionalFields: string[];
  /** Threshold for SIVRU-E211 block-prose warning. */
  maxLines: number;
  /** Locked set for SIVRU-E213 maturity-invalid; override-replaces-default. */
  maturityValues: string[];
  /** Reserved for DESIGN-0017 v0.7 ownership. v0.6 does not read this. */
  drift?: Record<string, unknown>;
};

/**
 * Layer-3 customization (DESIGN-0016 "Customization shape" §3). v0.7 uses
 * this to register cross-symbol drift validators. v0.6 reserves the
 * interface so projects can experiment without an API break later.
 */
export type BlockValidatorContext = {
  block: SivruBlock;
  config: SivruBlockConfig;
  filePath: string;
};

export type CustomBlockValidator = (
  context: BlockValidatorContext,
) => BlockDiagnostic[];
