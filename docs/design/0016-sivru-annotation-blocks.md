# DESIGN-0016: `@sivru` annotation blocks — authored code context

**Status:** Accepted (promoted from Draft on 2026-05-21 by
`/plan-eng-review` iter-4 PASS)
**Class:** Spine (per [GOALS.md](../../GOALS.md))
**Targets:** v0.6.0
**Issue:** filed when v0.6 work starts
**Created:** 2026-05-15
**Updated:** 2026-05-21 — eng-review iter-4 absorbed CEO plan iter-3
(D1, E1–E8, F1–F3) + the eng-review's own findings (A1 fence-
detection algorithm, A2 Python docstring edge cases, A3 schema
evolution rules, T1–T4/P1 test + CI fixes). Promoted Draft →
Accepted.
**Author:** @pochadri

## Problem

`sivru explain` (DESIGN-0004, v0.5.0) gives an agent *derived* facts
about a symbol — public API, 1-hop call graph, churn, ownership. All
of it is computed from code plus git. None of it answers the
questions that actually decide whether a change is safe:

- What is this symbol *for* — its role in the system, not its
  signature?
- What invariants must hold that the type system does not enforce?
- Why is it built this way — what was chosen, and what was rejected?
- Is that choice still valid, or has the world moved since?

Today that knowledge lives in three bad places: a senior engineer's
head, a stale `docs/` page, or nowhere. When an agent edits a file it
reconstructs intent from the code itself — which is exactly the
information that is missing, because the code is the *what*, not the
*why*.

The failure mode is concrete. An agent "correctly" refactors a
central router into per-channel routers. The tests pass. It has
silently destroyed a deliberate architectural decision — "channels
stay thin, routing logic stays in one place" — that no artifact
recorded. The decision had a reason and a lifetime; the agent never
saw either, so it could not weigh them.

## Proposal

### 1. The block (schema)

A `@sivru` annotation block: a small, structured, language-neutral
block of authored context, carried inside whatever doc-comment syntax
the host language already uses, attached to a code symbol OR to a
package/module via the language's convention.

The block is delimited `@sivru` ... `@end` and contains YAML:

```
@sivru
schema: 1
role: routing-brain
responsibility: resolve which solution owns an inbound message
collaborators: [SolutionRouteResolver, HookDispatcher]
invariants:
  - runs on the request thread; tenant context must be set first
decisions:
  - chose: one central router, not per-channel routers
    because: channels must stay thin; routing logic in one place
    valid-while: no channel needs channel-specific routing state
    revisit-if: a channel must route differently from the others
maturity: stable
@end
```

**Required fields:** `role`, `responsibility`. **Reserved version
slot:** `schema: 1` (see §5).

**Optional fields and their semantics:**

- `collaborators: string[]` — names of related symbols. v0.7 drift
  detector resolves these against the v0.2 symbol index.
- `invariants: string[]` — claims that must hold for the symbol to
  function correctly. Not enforced by sivru; documented for the
  reader.
- `decisions: object[]` — each entry is the four-field quadruple
  `{ chose, because, valid-while, revisit-if }`. `revisit-if` is
  optional but warned-on-missing (§4 SIVRU-E210).
- `maturity: 'stable' | 'experimental' | 'deprecated' | 'wip'` —
  locked set (§4 SIVRU-E213). Customizable via `.sivru/block.json`
  per §6.

A block with two fields (only `role` + `responsibility`) is valid
and useful; authoring cost scales with value, so the repo accumulates
depth exactly where depth matters.

### 2. Surfaces

- **Library (extractor + validator):** `extractBlocks()`,
  `validateBlock()`, `blockToJSON()` exported from
  `@sivru/search` (the `block/` subdirectory — see §7).
- **CLI:**
  - `sivru block validate [path]` — lints all `@sivru` blocks in
    the path (defaults to cwd). Non-zero exit on any error-level
    diagnostic. Drops into CI cleanly.
  - `sivru block extract [path] --json` — debug helper. Emits
    every block PLUS its diagnostics. **Critical: NEVER silently
    drops invalid blocks** (per the project memory rule on silent
    exclusion). Invalid blocks appear with `block: null` and
    `diagnostics: [...]` populated.
- **MCP:** none at v0.6. v0.7 (DESIGN-0017) surfaces blocks
  through the existing `sivru.explain` MCP tool.

Argument parsing is **hand-rolled** (no zod, matching v0.5
`parseSearchArgs` convention).

### 3. Extraction algorithm

```
extractBlocks(filePath: string): ExtractedBlock[]
  │
  ├─ tree-sitter parse (reuses v0.2 grammars)
  │
  ├─ per-symbol blocks:
  │   │
  │   ├─ indexComments(tree.rootNode, lines)         ← reuses v0.2
  │   ├─ attachLeadingComment(node, comments)        ← reuses v0.2
  │   └─ for each (symbol, leadingComment):
  │       └─ extractFence(comment.text)              ← new
  │
  └─ module-level blocks (E1, Python + TS only at v0.6):
      │
      ├─ Python: find first expression_statement child of `module`
      │          AST node where that statement is a bare string
      │          (NOT f-string). Honor PEP 257 strictly. Skip
      │          past `__future__` imports — a string statement
      │          immediately after `from __future__ import ...`
      │          still counts as the module docstring.
      │
      ├─ TS/JS: top-of-file block comment of the package's primary
      │         entry point. Resolution order:
      │            1. file resolved by package.json `main`
      │            2. fallback: src/index.ts
      │            3. fallback: index.ts
      │         `exports` subpath entries deferred to v0.6.x.
      │
      └─ Java + Go module-level deferred to v0.6.x.
```

**3a. Fence detection (the @sivru / @end algorithm).**

The fence delimiters MUST appear on their own line. Algorithm:

```
extractFence(commentText: string): { yaml: string, range: Range } | null
  for each line in commentText:
    strip leading whitespace AND leading comment-syntax prefix
    (e.g., "// ", " * ", "# ", "/// ")
    if remaining == "@sivru":
      start = lineNo
    if start !== null AND remaining == "@end":
      end = lineNo
      yaml = join(lines[start+1 .. end-1], "\n")
      return { yaml, range: { start, end } }
  return null  // no complete fence
```

**Rationale:** the "own-line" rule (whitespace-only before, optional
trailing whitespace after the delimiter, OR after stripping the
comment syntax prefix) means YAML string values can safely contain
the literal text `@end` without false matches — e.g.,
`revisit-if: token reaches '@end of life'` is fine because that
line begins with `revisit-if:`, not `@end` alone. The fence rule is
a property of the line, not the content.

**Edge cases (all → diagnostics, never crash):**

- `@sivru` without matching `@end` → `SIVRU-E215 fence-unclosed`
  (error).
- `@end` before `@sivru` → ignored; scan continues.
- Multiple `@sivru` blocks in one comment → all extracted (each
  with its own fence); valid use case for "two related symbols in
  one doc-comment block."
- Empty fence (`@sivru\n@end`) → yaml parses to null →
  `SIVRU-E217 missing-required` for missing `role` / `responsibility`.
- `@sivru` inside a code-fenced markdown sample inside the comment
  → matched (this is an honest-mistake risk that requires `@sivru`
  inside the user's own example to be escaped or quoted as part of
  YAML; documented as a "do not paste your own example block
  literally" caveat).

**3b. Per-language doc-comment syntax (the carrier).** Each
grammar's doc-comment node already located by v0.2 chunker
infrastructure:

- TS / JS / Java: `/** ... */` block comments above declarations
  (the chunker's `attachLeadingComment` handles).
- Go: contiguous `// ...` line comments immediately above (no blank
  line) — godoc convention.
- Python: in Python the per-symbol carrier is the function/class
  body's first statement when it is a bare string expression (PEP
  257 — *not* a `#` comment). Per-symbol Python blocks are
  docstrings, same as module-level.
- Rust: `/// ...` line comments (TODO: add Rust grammar if/when v0.6+
  adds Rust support — not in v0.6 scope).

### 4. Validation (the diagnostic table)

`validateBlock(block: SivruBlock): BlockDiagnostic[]` returns the
full diagnostic list. Severity policy: `error` exits the CLI
non-zero; `warning` prints to stderr but exits 0.

| Code | Severity | Trigger |
|------|----------|---------|
| `SIVRU-E210 decision-no-revisit` | warning | a `decision` is missing the `revisit-if` field (E2). v0.7 drift detector consumes this signal. |
| `SIVRU-E211 block-prose` | warning | block exceeds 25 lines. Tunable via `.sivru/block.json` `maxLines`. |
| `SIVRU-E212 block-runaway` | **error** | block exceeds 100 lines (hardcoded ceiling, NOT configurable). |
| `SIVRU-E213 maturity-invalid` | error | `maturity` value not in `{stable, experimental, deprecated, wip}` (E4). Customizable via `.sivru/block.json` `maturityValues` (override-replaces-default). |
| `SIVRU-E214 schema-version-unsupported` | error | `schema` value not 1 (strict-reject at v0.6 per E7). |
| `SIVRU-E215 fence-unclosed` | error | `@sivru` without matching `@end`. |
| `SIVRU-E216 yaml-malformed` | error | js-yaml threw on parse. Other blocks in the same file extract normally (F1). |
| `SIVRU-E217 missing-required` | error | `role` or `responsibility` missing. |
| `SIVRU-E218 module-locator-failed` | warning | Python/TS module-level locator could not parse the file's top-of-file structure. Per-symbol blocks in the file still extract. |
| E219 | reserved | for v0.6 implementation needs |

**Error-code range partition** (documented here for forward
compatibility):

- **v0.6:** `SIVRU-E210–E219`
- **v0.7:** `SIVRU-E220–E229` (drift diagnostics —
  `broken-collaborator`, `stale-block`, `expired-decision`).
  `missing-required` (E217) lives in the v0.6 range and v0.7's
  drift detector surfaces it verbatim, same code.
- **v0.8:** `SIVRU-E230–E239` (reserved for codebase-explainer
  diagnostics).

**BlockDiagnostic shape** (in `packages/search/src/block/types.ts`):

```ts
export interface SourceRange {
  filePath: string;
  startLine: number;  // 1-indexed inclusive
  endLine: number;    // 1-indexed inclusive
}

export interface BlockDiagnostic {
  code: string;            // "SIVRU-E210" etc.
  severity: 'error' | 'warning';
  message: string;
  location?: SourceRange;  // optional only for repo-wide diagnostics
                           // that don't have a single source range
                           // (currently unused at v0.6; reserved for
                           // future cross-file diagnostics)
}
```

### 5. JSON shape + schema evolution (E6 + E7 + A3)

`packages/search/src/block/toJSON.ts` exports:

```ts
function blockToJSON(block: SivruBlock): SivruBlockJSON;
```

**SivruBlockJSON canonical shape:**

```jsonc
{
  "schema": 1,
  "role": "<string>",
  "responsibility": "<string>",
  "maturity": "stable|experimental|deprecated|wip|null",
  "collaborators": [<string>],
  "invariants": [<string>],
  "decisions": [
    {
      "chose": "<string>",
      "because": "<string>",
      "validWhile": "<string>",
      "revisitIf": "<string>|null"
    }
  ]
}
```

**Schema evolution rules (A3 — pinned):**

- **Minor-additive changes stay at `schema: 1`.** New optional
  fields can be added at v0.6.x or later without bumping the
  schema. Consumers ignore unknown fields gracefully (forward-
  compat by additive convention).
- **Breaking changes bump to `schema: 2`.** Removing or renaming a
  field. Changing a required-set. Changing the semantic meaning of
  an existing field. Any of these requires the schema bump.
- **v0.6 strict-reject:** any `schema` value other than `1` triggers
  `SIVRU-E214 schema-version-unsupported`. v0.6.x or v0.7+ may
  relax to graceful-downgrade when mixed-version repos appear in
  the wild.

The v0.7 `explain.authored[]` consumption contract fixture is
**owned by DESIGN-0017**, not v0.6. v0.6 ships `blockToJSON()` with
a stable shape; v0.7 ships a contract test asserting its
consumption shape matches `blockToJSON()` output for the 21
dogfood symbols.

### 6. Configuration (`.sivru/block.json` schema)

Project config (`<repo>/.sivru/block.json`) beats user config
(`~/.config/sivru/block.json`) beats defaults. Same precedence as
v0.5's `.sivru/explain.json`.

**`.sivru/block.json` schema (exhaustive — implementers must not
add keys without updating this list):**

```jsonc
{
  "requiredFields": ["role", "responsibility"],  // default
  "optionalFields": [
    "collaborators", "invariants", "decisions", "maturity"
  ],  // default; can extend with custom field names if layer-3
       // validators register
  "maxLines": 25,                  // SIVRU-E211 warning threshold
  "maturityValues": [              // override-replaces-default
    "stable", "experimental", "deprecated", "wip"
  ],
  "drift": { /* reserved for DESIGN-0017 ownership */ }
}
```

**Override-replaces-default semantics** (E4): user-supplied
arrays fully replace the default array. Authors who want to extend
the default set must include the original values in their override.

`maxLines` controls only the `SIVRU-E211 block-prose` warning. The
`SIVRU-E212 block-runaway` 100-line ceiling is **hardcoded and NOT
configurable.** Implementers must not add a `maxRunawayLines` key.

### 7. Module layout

```
packages/search/src/block/
  types.ts          — SivruBlock, ExtractedBlock, BlockDiagnostic,
                       SourceRange, SivruBlockJSON
  index.ts          — public exports
  extract.ts        — extractBlocks(filePath, tree) →
                       ExtractedBlock[]
                       (fence detection + yaml.load wrapping)
  validate.ts       — validateBlock(block) → BlockDiagnostic[]
                       (all SIVRU-E210–E218 checks)
  toJSON.ts         — blockToJSON(block) → SivruBlockJSON
  config.ts         — loadBlockConfig() with project-beats-user-
                       beats-default precedence
  module-locators/  — extracted module-level rule per language
    python.ts       — module docstring (PEP 257 strict)
    typescript.ts   — top-of-file block comment + main/src/index/index
                       fallback chain
  __fixtures__/
    per-language/   — 5 language fixtures for per-symbol blocks
    module-level/   — Python __init__.py + TS index.ts fixtures
    pathological/   — F3 deep-nest fixture for memory safety
    fence-edges/    — T1 unclosed / multi / @end-in-string fixtures
```

```
packages/cli/src/commands/
  block.ts          — sivru block validate / extract subcommand
  block.test.ts     — CLI smoke + integration tests
```

D14 (the shared-parse-with-search optimization deferred at the
v0.5 eng-review) now lives in the same module as the chunker —
when measured to matter, the chunker can emit pre-located doc-
comment ranges and `extractBlocks` reads from them instead of
re-walking the tree. Not v0.6 scope; tracked in TODOS.

## Alternatives considered

**A sidecar manifest** (`.sivru/context.yaml`, one file). Non-
intrusive and language-free. Rejected: it drifts the instant code
moves, and nothing in code review forces it current. The whole
point is context that travels *with* the symbol it describes.

**Native doc-comment conventions only** (Javadoc tags, TSDoc tags,
godoc prose). Rejected: each language's tag vocabulary and tooling
differ, none has anything like `valid-while`, and we would be
maintaining five incompatible schemas. The fenced `@sivru` block
reuses the comment purely as a *carrier* and keeps one schema.

**A new comment syntax or decorator.** Rejected: anything that is
not already a comment breaks compilers, linters, and formatters.
The block must be invisible to every tool except sivru.

**Authoring blocks through a sivru command into sivru's index,
never in source.** Rejected: defeats the purpose. The context
would live outside the repo, invisible in code review and in the
editor, and would not survive a clone.

**Custom YAML subset parser** (vs js-yaml dep). Rejected at the
CEO review (E8). js-yaml v4+ safe-load has well-understood
error messages and the long-tail YAML edge cases (Norway-bug,
type coercion, multi-line strings) are worth the 30KB dep.

**`@sivru/block` as a separate package.** Considered against the
v0.5 D1 precedent. Rejected: block extraction reuses the chunker's
tree-sitter substrate; sibling-subdir to v0.5's
`packages/search/src/explain/` keeps the comprehension layer
unified.

## DESIGN-0004 reconciliation gate (v0.5 forward-pointer)

DESIGN-0004 v0.5 reserved the `authored: []` field on the explain
artifact. The v0.6 PR description for this design MUST include a
section titled "DESIGN-0004 reconciliation" that states the v0.6
contract for filling the `authored` field on `sivru explain`
artifacts. Specifically:

- v0.6 fills `artifact.authored[]` entries via `blockToJSON()`
  output for symbols that have blocks.
- v0.6 does NOT change v0.5's existing test surface
  (`Array.isArray(artifact.authored)` test still passes — v0.6
  just changes the runtime content, not the contract).
- v0.7's `sivru explain` integration ships the actual surfacing
  per DESIGN-0017.

CI rejects v0.6 PRs whose description does not contain the
"DESIGN-0004 reconciliation" heading.

## DESIGN-0017 sync prerequisites (2 items for the v0.7 cycle)

These are NOT v0.6 work but must be tracked so v0.7 absorbs them:

1. **SKILL.md authoring section reassigned to v0.6.** DESIGN-0017
   §3 ("`@sivru/skill` gains an authoring section") becomes
   "`@sivru/skill` gains a READ-the-block-before-editing section
   on top of v0.6's authoring section."
2. **Drift detector consumes `SIVRU-E210 decision-no-revisit`.**
   DESIGN-0017 §"Proposal 2" enumerates four diagnostics; v0.7
   adds E210 as a fifth (warning-level: "decisions without
   revisit-if"). Error-code range partition: v0.6 owns
   E210–E219; v0.7 owns E220–E229.

## Open questions resolved by CEO + eng review

- **Module-level context attachment.** Resolved at E1: language-
  convention top-of-file (Python docstring per PEP 257; TS top-of-
  file block comment). Java + Go module-level deferred to v0.6.x.
  Sidecar YAML option rejected.
- **`decision` without `revisit-if`.** Resolved at E2: warning,
  not error, not silent (`SIVRU-E210`). v0.7 drift detector
  consumes the signal.
- **Block size cap.** Resolved at E3: warning at 25 lines
  (`SIVRU-E211`), error at 100 lines (`SIVRU-E212`). 100-line
  ceiling hardcoded; 25-line threshold tunable via `.sivru/
  block.json` `maxLines`. "Block lines" precisely defined as
  physical source lines from `@sivru` through `@end` inclusive.

## Acceptance criteria

- **Module location:** `packages/search/src/block/` subdirectory of
  `@sivru/search` (matches v0.5 D1 pattern; consistent with
  DESIGN-0017's planned `block/drift.ts` addition).
- **Schema:** `role` + `responsibility` required; `schema: 1`
  reserved version slot; `maturity` locked to four values
  (`stable / experimental / deprecated / wip`); `collaborators`,
  `invariants`, `decisions` optional.
- **Extraction:** `extractBlocks()` reuses v0.2's
  `indexComments()` + `attachLeadingComment()` for per-symbol
  blocks; module-level locators in `module-locators/python.ts` +
  `module-locators/typescript.ts` for Python + TS at v0.6.
- **Fence detection:** `@sivru`/`@end` delimiters must appear on
  their own line (whitespace-only before, optional trailing
  whitespace, after stripping the comment-syntax prefix). YAML
  string values containing `@end` text do not trigger false fence
  matches.
- **Validation:** every diagnostic in the §4 table is emitted with
  the correct severity and code. CLI exit-code reads from
  `BlockDiagnostic.severity`.
- **Schema evolution:** minor-additive changes stay at `schema: 1`;
  breaking changes bump to `schema: 2`; v0.6 strict-rejects
  unknown schemas.
- **JSON serialization:** `blockToJSON()` produces the §5 canonical
  shape. Round-trip test asserts parse → SivruBlock → toJSON →
  matches expected per-symbol AND per-module fixtures across all
  4 carrier syntaxes (Java/Go/TS/Python).
- **CLI:** `sivru block validate [path]` exits non-zero on any
  error-level diagnostic. `sivru block extract [path] --json`
  emits every block plus its diagnostics, never silently drops.
- **Self-dogfood:** 21 named symbols across `@sivru/search` +
  `@sivru/cli` (E5 enumerated table) carry `@sivru` blocks. v0.6
  PR commits these blocks. CI gate: count ≥ 21 AND distinct roles
  ≥ 5.
- **CI command:** the GitHub Actions workflow runs
  `node packages/cli/dist/index.js block validate packages/` (NOT
  `pnpm sivru block validate` — the `sivru` binary is not
  globally linked in CI). A workspace-root `"sivru": "node
  packages/cli/dist/index.js"` pnpm script provides developer
  convenience for local runs.
- **DESIGN-0004 reconciliation gate** (above): v0.6 PR description
  MUST carry the named heading.
- **Performance gate:** extraction adds < 5% to index time on the
  vitest corpus, defined as `packages/search/src/chunker/
  __fixtures__/` (~50 files, < 1s baseline). v0.6 PR confirms the
  gate holds on a re-measurement after the new module ships.
- **Threat model (F2):** js-yaml pinned to `^4.0.0`; only
  `yaml.load()` called (NEVER `loadAll()` or any
  `DEFAULT_FULL_SCHEMA` variant). v0.6 PR confirms via a unit
  test that loads a hostile fixture (yaml that would deserialize
  a JS object under unsafe schema) and asserts the result is just
  a plain object, no method execution.
- **Memory safety (F3):** pathological-yaml fixture under
  `packages/search/src/block/__fixtures__/pathological/deep-nest.ts`
  asserts `extractBlocks()` completes in < 10ms with bounded memory
  allocation.

## Test plan

### Unit tests

- **Fence detection:** per-language fixture files with fenced
  `@sivru`/`@end` block in:
  - TS `/** ... */`
  - JS `/** ... */`
  - Java `/** ... */`
  - Go `// ...` contiguous block
  - Python module docstring `"""..."""`
  - Python function docstring `"""..."""`
- **Fence edge cases** (T1, in `__fixtures__/fence-edges/`):
  - Unclosed: `@sivru` without `@end` → `SIVRU-E215 fence-unclosed`
  - Multiple in one comment: two `@sivru`/`@end` pairs → both
    extracted
  - `@end` inside YAML string value (`revisit-if: 'lifecycle hits
    @end of life'`) → fence correctly closes at the standalone
    `@end` line, not the embedded one
  - Whitespace variations: `@sivru` with trailing space, tab-
    indented `@sivru`, comment-syntax-prefix variations (`* @sivru`,
    `/// @sivru`)
- **Validation per diagnostic** — fixture per row of the §4 table:
  one invalid block triggering each of E210–E218 + the
  valid-minimal case.
- **Schema rejection:** block with `schema: 2` → `SIVRU-E214`.
- **maturity rejection:** block with `maturity: production` →
  `SIVRU-E213`.
- **Override semantics:** `.sivru/block.json` with
  `maturityValues: ['gold', 'silver']` → block with
  `maturity: gold` validates clean; block with `maturity: stable`
  → `SIVRU-E213` (override REPLACES, not extends).
- **Threat model unit test (F2):** load a yaml fixture that, under
  `DEFAULT_FULL_SCHEMA`, would deserialize a JS object with custom
  methods. Assert the parsed result has no custom methods (safe-
  load mode confirmed).
- **JSON round-trip:** identical block content in 5 carrier
  syntaxes (TS / JS / Java / Go / Python — per-symbol) → same
  `SivruBlockJSON` shape per `blockToJSON()`.
- **Module-level round-trip (T2):** Python `__init__.py` with
  module docstring → SivruBlock with `kind: 'module'`. TS
  `src/index.ts` with top-of-file `/** @sivru ... @end */` →
  SivruBlock with `kind: 'module'`. Same content in both →
  matching `SivruBlockJSON`.
- **PEP 257 strict (A2):** Python module with `from __future__
  import annotations` followed by a docstring → docstring still
  recognized as module-level block. Python module starting with
  an f-string → NOT recognized as docstring (matches CPython
  behavior).
- **TS main fallback (A2):** package.json without `main` →
  locator falls back to `src/index.ts`, then `index.ts`. Missing
  all three → `SIVRU-E218 module-locator-failed` warning.

### Integration tests

- **`buildExplainIndex`-style round-trip:** small multi-file
  fixture repo with 5–10 blocks → extractBlocks returns the
  expected set; validateBlock per block returns expected
  diagnostics; serialized JSON matches per-fixture expected
  output.
- **CLI smoke:** `sivru block validate packages/` exits 0 on a
  fixture repo with all-valid blocks; exits 1 on a fixture with
  one error-level diagnostic; emits the diagnostic message and
  location.
- **`extract --json` faithfulness:** invalid block in a fixture
  → output array contains the entry with `block: null` AND
  `diagnostics: [...]` populated. Never silently dropped.
- **Pathological yaml (F3):** the `__fixtures__/pathological/
  deep-nest.ts` test runs `extractBlocks` over the file and
  asserts: returns within 10ms; memory allocation is bounded;
  diagnostics contain a `SIVRU-E216 yaml-malformed` or
  `SIVRU-E212 block-runaway` depending on which threshold fires
  first.

### Self-dogfood test gate (E5)

- v0.6 PR commits 21 `@sivru` blocks across the symbols in the E5
  enumerated table.
- CI runs:
  ```
  node packages/cli/dist/index.js block validate packages/
  ```
  asserting exit 0.
- CI runs the role-coverage gate (node script, no jq dep):
  ```js
  const { execSync } = require('node:child_process');
  const out = JSON.parse(execSync(
    'node packages/cli/dist/index.js block extract packages/ --json'
  ));
  if (out.length < 21) {
    console.error(`expected >= 21 blocks, got ${out.length}`);
    process.exit(1);
  }
  const roles = new Set(
    out.map(e => e.block?.role).filter(Boolean)
  );
  if (roles.size < 5) {
    console.error(`expected >= 5 distinct roles, got ${roles.size}`);
    process.exit(1);
  }
  ```

### Performance gate

- `packages/search/src/chunker/__fixtures__/` is the vitest corpus.
- Baseline: re-run `pnpm --filter @sivru/search test` before the
  v0.6 PR opens; record total test suite duration.
- After v0.6 PR: same measurement. Assert
  `(new_duration - baseline) / baseline < 0.05` (< 5% increase).
- Documented in CHANGELOG with the measured number, not the
  budget number.

### Dogfood content review (PR-stage)

The 21 dogfood blocks ship in a public repo. PR review confirms:

- No secrets, internal-only URLs, or sensitive metadata.
- Every `decisions[]` entry's `chose`/`because`/`valid-while`/
  `revisit-if` reads plainly and avoids marketing or AI vocabulary
  per the project memory `feedback_plain_user_facing_text`.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — schema in §1 + §4; required fields
   `role`, `responsibility`; locked `maturity` set; `maxLines`
   default 25 (warning) and hardcoded 100 (error). All defined in
   `packages/search/src/block/config.ts`.
2. **Declarative override** — `~/.config/sivru/block.json` (user)
   and `.sivru/block.json` (per-project, wins):
   `{ requiredFields, optionalFields, maxLines, maturityValues,
   drift }`. Override-replaces-default semantics for arrays
   (E4). `drift` key reserved for DESIGN-0017 v0.7 ownership.
   `maxLines` controls only the warning threshold; the 100-line
   error ceiling is not configurable.
3. **Code-level extension** — `.sivru/block/*.ts` register
   custom field validators (for example, "`collaborators` entries
   must resolve to real indexed symbols"). The validator
   interface lives in `packages/search/src/block/types.ts`. v0.7
   uses this layer for the cross-symbol drift checker.

## Effort

| Item | Working days |
|---|---|
| DESIGN-0016 rewrite (this doc, already shipped at eng-review) | (sunk) |
| D1 baseline (extract + validate + CLI for 5 grammars) | ~3–4w |
| E1 module-level (Python + TS only) | ~0.5d |
| E5 dogfood (21 named symbols, spike-first protocol) | ~5–7d |
| E6 JSON shape + E7 schema version | ~0.5d |
| E8 js-yaml dep + safe-load enforcement (F2) | ~2hrs |
| F1 yaml-malformed handling | ~15min |
| F3 pathological-yaml fixture + assertion | ~30min |
| SKILL.md authoring section | ~0.5d |
| Fence edge-case fixtures (T1) | ~30min |
| Module-level round-trip tests (T2) | ~30min |
| CI command + workspace `sivru` script (T3) | ~30min |
| Performance baseline measurement + gate (T4/P1) | ~30min |
| E2/E3/E4 validation rules | ~1hr |
| **Total** | **~4.5–5.5 weeks** |

Critical path: D1 baseline → E5 dogfood (these are the two big
items). Everything else parallelizes against the baseline.

## Worktree parallelization strategy

After the spine (D1 extract.ts + validate.ts + types.ts) is in
place, three lanes can run in parallel:

| Lane | Tasks | Module | Depends on |
|---|---|---|---|
| A | D1 baseline → E5 dogfood | `packages/search/src/block/` + 21 source files | — |
| B | E1 module-locators (Python + TS) | `packages/search/src/block/module-locators/` | spine (extract.ts) |
| C | CLI + tests + dogfood gate | `packages/cli/src/commands/block.ts` + CI | spine (validate.ts) |

E5 (the 21 dogfood blocks) authoring is sequential per-block but
can be parallelized across two contributors (10 + 11).

**Conflict flag:** Lanes A and C both touch package.json
(`js-yaml` dep + workspace sivru script). Coordinate the dep-
add commit before the lanes diverge.

---

## GSTACK REVIEW REPORT

*CEO + eng review log for v0.6.0. Per `/plan-eng-review` skill —
review log, decisions ledger, dashboard, next-steps. CEO plan with
full decision rationale lives at
`~/.gstack/projects/sivru/ceo-plans/2026-05-21-sivru-annotation-blocks.md`.*

### Iteration history

| Iter | Reviewer | Outcome | Findings | Lock state |
|------|----------|---------|----------|------------|
| 1 | `/plan-ceo-review` spec-review | REVISE | 24 issues across 5 dimensions, quality 6/10 | Iter-1 CEO plan stale relative to feasibility / consistency / clarity gaps |
| 2 | `/plan-ceo-review` spec-review | REVISE | 22 second-order issues, quality 7/10 | Cross-doc reconciliation with DESIGN-0017 needed; BlockDiagnostic shape under-specified; role-coverage arithmetic off |
| 3 | `/plan-ceo-review` spec-review | **PASS** | 8.5/10 (2 trivial editorial nits cleaned inline) | CEO plan locked; D1 + E1–E8 + F1–F3 decisions absorbed |
| 4 | `/plan-eng-review` (this rewrite) | **PASS** | 9 findings (3 architectural + 4 test/CI/perf + 2 documentation), all resolved by inline fold per the workflow-pacing memory rule | DESIGN-0016 promoted Draft → Accepted |

### Decisions absorbed in this eng-review

**From CEO iter-3 (carried verbatim):** D1 baseline (library + CLI
+ self-dogfood); E1 module-level (Python + TS only); E2 decision-
no-revisit warning; E3 block size warn/error thresholds; E4
maturity 4-value lock; E5 medium dogfood (21 symbols); E6 v0.6
JSON pre-lock; E7 schema:1 strict-reject; E8 js-yaml dep; F1 yaml-
malformed diagnostic; F2 js-yaml safety pin; F3 pathological-yaml
fixture.

**Net new in this eng-review (folded without separate AUQs per
the workflow-pacing memory rule):**

- **A1 — Fence-detection algorithm.** Line-based scan with
  "@sivru / @end on their own line" rule. YAML string values
  containing `@end` are safe by the own-line constraint.
- **A2 — PEP 257 Python edge cases.** First statement of module
  body as bare string expression, ignoring `__future__` imports;
  reject f-strings (matches CPython).
- **A3 — Schema evolution rules.** Minor-additive stays at
  `schema: 1`; removing/renaming/changing-required-set bumps to
  `schema: 2`. Documented in §5.
- **T1 — Fence-edge-case test fixtures.** Four new fixtures under
  `__fixtures__/fence-edges/`: unclosed, multiple-in-one-comment,
  `@end`-in-yaml-string, whitespace variations.
- **T2 — Module-level round-trip test.** Extended round-trip
  suite to cover Python `__init__.py` docstring + TS
  `src/index.ts` top-of-file as module-level blocks.
- **T3 — CI command path fix.** `node packages/cli/dist/
  index.js block validate packages/` (NOT `pnpm sivru` — binary
  not linked in CI). Workspace-root `sivru` pnpm script for
  developer convenience.
- **T4 / P1 — Vitest corpus definition.**
  `packages/search/src/chunker/__fixtures__/` is the baseline.
  CHANGELOG records measured overhead, not budget.
- **P2 — Large-repo perf.** Honest CHANGELOG note; v0.6.x
  revisit if reported.
- **Fact-check.** js-yaml is NOT yet transitive in the lockfile;
  must be added as a new direct dep via
  `pnpm add js-yaml@^4 @types/js-yaml --filter @sivru/search`.

### Dashboard

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (iter-3 PASS) | CLEAR | 8 proposals, 8 accepted, 7 deferred |
| Eng Review | `/plan-eng-review` (this) | Architecture & tests (required) | 1 (iter-4 PASS) | CLEAR | 9 issues, 0 critical gaps |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — (no UI scope at v0.6) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

### Outside voice (this eng-review)

**Skipped.** Three rounds of spec-review on the CEO plan
(iter 1 → 2 → 3 PASS at 8.5/10) already provided independent
review depth. v0.6 is a "build the obvious thing" release with
DESIGN-0017 and DESIGN-0018 as clear downstreams; not a strategic
re-question. Per the workflow-pacing memory established this
session, additional outside voice is double-work at this stage.

### VERDICT

**CLEARED.** CEO iter-3 PASS + eng-review iter-4 PASS. DESIGN-0016
promoted from Draft (stub) to **Accepted**. No unresolved
decisions. Zero critical failure-mode gaps.

### Next steps

1. **Open design PR.** `design/sivru-annotation-blocks` → `main`.
   Pure docs PR. User merges (same pattern as v0.5's PR #22).
2. **Create worktree + feat branch off updated main.**
   `git worktree add ../sivru-annotation-blocks
   -b feat/sivru-annotation-blocks main`.
3. **`/auto-ship`** against this Accepted design + the v0.6 tasks
   sidecar.
4. **v0.6.0 ship** — `release: v0.6.0 — @sivru annotation blocks`
   commit + `v0.6.0` tag (same pattern as v0.5's 76fcf82).

### Handoff note

DESIGN-0016 is **Accepted** as of 2026-05-21. Four reviews
(CEO iter 1 → 2 → 3 PASS, eng-review iter-4 PASS) have shaped
the spec across §1–§7, acceptance criteria, and test plan.
Twelve decisions (D1, E1–E8, F1–F3) plus nine eng-review
findings (A1–A3, T1–T4, P1–P2 + js-yaml fact-check) absorbed.
The doc is implementation-ready; the next handoff is the design
PR → main, then `/auto-ship` against the task sidecar.
