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

/**
 * Object form of an invariant (DESIGN-0019 §1). The original string form
 * stays valid and is treated as `{ rule: <string>, "enforced-by": null }`
 * by `validateBlock`. Schema stays at 1 — the change is purely additive.
 */
export type SivruInvariant = {
  rule: string;
  /**
   * Reference to the test that proves the invariant. Two accepted forms:
   *   - symbol form:        `ClassName.methodName`
   *   - file-anchored form: `<path>::<test-name>`
   * `null` means the author explicitly declared "no test yet" — surfaced
   * by `SIVRU-E232 enforcement-unset` (warning by default).
   */
  "enforced-by": string | null;
};

export type SivruBlock = {
  schema: number;
  role: string;
  responsibility: string;
  collaborators?: string[];
  /**
   * Invariants accept either bare-string form (legacy) or the object
   * form added in DESIGN-0019 slot 1. Both forms can mix in one block.
   */
  invariants?: (string | SivruInvariant)[];
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
  /**
   * `SIVRU-E2XX` namespace per DESIGN-0019 §"Error-code range partition":
   *   - v0.6 (DESIGN-0016):                   E210..E219
   *   - DESIGN-0017 baseline drift (v0.8):    E220..E229
   *   - DESIGN-0019 slot 1 (provable+ergo):   E230..E239
   *   - DESIGN-0019 slot 3 (bridges):         E260..E269
   *   - DESIGN-0019 slot 4 (carriers):        E270..E279
   * Codes are stable — never renumber.
   */
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

/**
 * Object-form invariant in the JSON wire shape (DESIGN-0019 §1). The
 * YAML hyphenated `enforced-by` is camelCased to `enforcedBy`. Bare-
 * string YAML invariants become `{ rule: <string>, enforcedBy: null }`
 * here so downstream consumers always see a uniform shape.
 */
export type SivruInvariantJSON = {
  rule: string;
  enforcedBy: string | null;
};

export type SivruBlockJSON = {
  schema: number;
  role: string;
  responsibility: string;
  maturity: string | null;
  collaborators: string[];
  invariants: SivruInvariantJSON[];
  decisions: SivruDecisionJSON[];
};

/**
 * Per-language line caps for SIVRU-E211 block-prose. Object form added
 * in DESIGN-0019 slot 4 — `default` is the fallback, language-keyed
 * entries override per language (matching the chunker's language ids:
 * `typescript`, `javascript`, `python`, `go`, `java`, `rust`, `tsx`,
 * `jsx`). The single-number config form stays valid as shorthand
 * (DESIGN-0019 §8 — "existing single-number form (`"maxLines": 25`)
 * stays valid as shorthand for `{ "default": 25 }`").
 */
export type SivruBlockMaxLines = {
  default: number;
  java?: number;
  typescript?: number;
  javascript?: number;
  tsx?: number;
  jsx?: number;
  python?: number;
  go?: number;
  rust?: number;
};

/** Config schema (DESIGN-0016 §6). Override-replaces-default for arrays. */
export type SivruBlockConfig = {
  requiredFields: string[];
  optionalFields: string[];
  /**
   * Threshold for SIVRU-E211 block-prose warning. Number form keeps the
   * v0.6 shape; object form (DESIGN-0019 slot 4) lets per-language
   * thresholds override the default.
   */
  maxLines: number | SivruBlockMaxLines;
  /** Locked set for SIVRU-E213 maturity-invalid; override-replaces-default. */
  maturityValues: string[];
  /**
   * DESIGN-0019 slot 1: promote `SIVRU-E232 enforcement-unset` from
   * warning to error when `enforcement.requireForObjectInvariants` is
   * true. Defaults to false.
   */
  enforcement?: {
    requireForObjectInvariants?: boolean;
  };
  /** DESIGN-0019 slot 1: default `--changed-since` ref for CI scripts. */
  diff?: {
    defaultSince?: string;
  };
  /**
   * DESIGN-0019 slot 2: cross-block graph diagnostic config.
   *   - `allowedAsymmetric`: list of "A->B" edges to suppress E234 for.
   *   - `orderingChecks`: enable E236 (default off).
   */
  graph?: {
    allowedAsymmetric?: string[];
    orderingChecks?: boolean;
  };
  /**
   * DESIGN-0019 slot 3: annotation→invariant bridge overrides.
   *   - `<lang>`: map of annotation marker → canonical invariant string.
   *   - `disable`: list of annotation markers to suppress entirely.
   */
  bridges?: {
    java?: Record<string, string>;
    python?: Record<string, string>;
    disable?: string[];
  };
  /** Reserved for DESIGN-0017 v0.7 / DESIGN-0019 slot 2 ownership. */
  drift?: Record<string, unknown>;
  /** DESIGN-002X reserved (watchable `revisit-if`). v0.x ignores it. */
  decisions?: Record<string, unknown>;
  /** DESIGN-0019 §11 reserved (generated-code mappings). v0.x ignores it. */
  generated?: Record<string, unknown>;
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
