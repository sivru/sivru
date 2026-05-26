# DESIGN-0019: Block reliability — provable claims, drift surfaces, broader coverage

**Status:** Accepted (promoted from Draft on 2026-05-26 by `/plan-ceo-review` iter-1 + `/plan-eng-review` iter-1 PASS) <!-- Stub → Draft → Accepted → Implemented → Superseded -->
**Class:** Spine (per [GOALS.md](../../GOALS.md) — directly hardens the
authored-comprehension layer)
**Targets:** multi-release plan (see "Release plan" below). First slot
TBD against the post-v0.7 backlog.
**Issue:** filed when v0.8 work starts
**Extends:** [DESIGN-0016](0016-sivru-annotation-blocks.md) (schema:1 — `@sivru` block extraction + validation)
**Built-on:** [DESIGN-0017](0017-serving-authored-context.md) (v0.8 — block surfacing in `sivru explain` + baseline drift)
**Created:** 2026-05-26
**Updated:** 2026-05-26 — folded a second batch of real-usage
feedback (10 items) from authoring 24 Java blocks in a Quarkus/
Hibernate codebase (BuildWright). Records, enums, package-info,
YAML colon-trap, annotation→invariant bridge, generated code, and
JavaDoc tag sync. See expanded §8 + new §9–§11; release plan
re-split into 5 firm slots.
**Author:** @pochadri
**Inputs:** real-usage feedback from an agent driving v0.6 blocks in
two production repos:
- **Batch A (initial 8 items):** 500-class TypeScript repo, 32 blocks
  authored. Identified the structural gap "blocks make CLAIMS but
  nothing PROVES the claims stay true."
- **Batch B (10 follow-on items):** Quarkus/Hibernate Java repo
  (BuildWright), 24 blocks authored. Identified Java-specific
  carrier gaps (records, enums, package-info, inner/sealed),
  YAML authoring traps on Java idioms (colon-in-prose, apostrophe-
  comma), the annotation→invariant under-leverage, and the
  generated-code attachment problem.

This design absorbs all 18 items and proposes a **four-slot release
split** (slot 4 in batch B's original ranking — watchable
`revisit-if` — is deferred to a follow-on DESIGN-002X per eng-review
iter-1 scope reduction).

## Problem

[DESIGN-0016](0016-sivru-annotation-blocks.md) shipped `@sivru` blocks
at v0.6: structured, in-repo authored context — `role`,
`responsibility`, `invariants`, `decisions`, `collaborators`,
`maturity`. [DESIGN-0017](0017-serving-authored-context.md) plans the
v0.8 surfacing layer (`sivru explain` integration + four drift
diagnostics — `broken-collaborator`, `missing-required`, `stale-block`,
`expired-decision`).

After real usage in a 500-class TypeScript repo, the agent driving
sivru reported a single structural gap that subsumes everything else:

> Blocks make CLAIMS but nothing PROVES the claims stay true.

Today, `invariants` are prose. `decisions[].revisit-if` is prose.
`collaborators` is a one-sided list. The validator catches schema
errors but not the higher-order question — *does the block still match
reality?* DESIGN-0017's `stale-block` heuristic catches one slice
(body-hash drift); it does not catch:

- An invariant that no test enforces ("tenant context cleared per
  iteration" — what proves it stays true?).
- A diff that touched a file but not its block (behavior changed; the
  block silently lies).
- A `collaborators: [B]` reference where B's block omits A (broken
  back-reference, or rename leaving stale names).
- A `revisit-if` whose condition is currently true in production (the
  decision rotted; nobody noticed).

Two ergonomic gaps surfaced alongside the reliability ones, both
flagged with concrete repro:

- `sivru block validate path1 path2 path3` silently shows help and
  exits non-zero. The agent shipped a broken CI line and had to push a
  follow-up commit. **This cost a CI commit on a real branch.**
- Authoring a block from scratch takes ~3 min per symbol, half of
  which is reconstructing the collaborator graph by reading imports —
  exactly the work sivru's index already did.
- At a 500-class repo, full-tree `validate` scans linearly: ~10s for
  32 blocks projects to multi-minute CI. Diff-scoped validation is
  the standard CI shape for every comparable lint tool.

Finally, the real-usage report flagged language-coverage gaps: TS
records and enums lack a clean attachment point (the agent had to move
the block to a method or parent class). Python and Go per-symbol
support exists at v0.6 but has known seams; Rust is not in scope.

**Java authoring (batch B, 24 blocks in BuildWright).** A second
round of real-usage feedback surfaced a different cluster of gaps,
all hit at least once during authoring:

- **Records and enums can't host class-level blocks.** Hit 3 times in
  one repo (`MemoryWriteScope` record, `HookEvent` enum,
  `SolutionStatus` nested enum). The block moved to an internal
  method or the parent class — burying the contract in less-obvious
  code. Records-as-DTOs are increasingly common; if sivru wants to
  model "load-bearing" honestly, it must accept them as block
  hosts.
- **YAML colon-trap on Java idioms.** Java JavaDoc carries
  `key: value`, `tx: REQUIRES_NEW`, `@Inject: …` patterns
  constantly. Bare YAML treats `:` as a mapping separator. First
  block failed validation; workaround was `"…"`-wrapping every
  invariant.
- **YAML single-quote + comma trap.** `'this.commit()'` parses as a
  single-quoted YAML string; a later comma triggers "mapping entry
  not allowed here" — inscrutable error that does not point at the
  apostrophes.
- **`maturity` enum rejected with no "did you mean".** `maturity:
  beta` rejected; the error did not suggest `experimental`. For
  authors who live in alpha/beta/GA vocabulary, this is a 30-second
  confusion every time.
- **25-line block-prose cap is tight for Java verbosity.** Hit on 2
  of 24 blocks (`SkillToolExecutor`, `SolutionDefinitionEntity`).
  Java JavaDoc conventions favor explanation; invariants about
  tenant isolation or RBAC routinely need 3–4 lines each.
- **`package-info.java` has no block host.** Package-wide
  contracts (e.g., "every entity here is tenant-scoped; never
  disable the filter") have nowhere to live. The contract ends up
  on the enforcement code, not on the package boundary it
  describes.
- **Generated code has nowhere to host.** Lombok-generated
  builders, Hibernate runtime proxies, MapStruct build-time
  mappers, Quarkus build-time CDI beans. When the load-bearing
  thing is the generated impl, no source file exists for a block.
  This gets worse as build-time DI spreads.
- **No bridge to Java annotations that already encode invariants.**
  `@ApplicationScoped` ⇒ "thread-safe; no instance state".
  `@Transactional` ⇒ "must be called via CDI proxy; never
  `this.method()`". `@Filter("tenantFilter")` ⇒ "tenant-scoped;
  JPQL only". The block author repeats what is already in code.
- **Inner classes and sealed types — coverage unclear.** Discovery
  semantics undocumented; needs an audit + spec.
- **No `@since` / `@deprecated` ↔ `maturity` sync.** JavaDoc
  `@deprecated` and block `maturity: deprecated` are the same
  fact; they can drift today.

## Proposal

Eight capabilities, grouped into the layers they harden. Each is
small enough to ship inside a focused 1–4 week release.

### 1. Invariant → test linkage (highest leverage)

A block says "tenant context cleared per iteration." What enforces
that? Today: prose hope. Add an optional `enforced-by` field on
invariants.

**Schema (additive, stays at `schema: 1`).** The invariants field
currently accepts `string[]`. Extend to accept the object form;
strings remain valid as shorthand for `{ rule: <string>,
enforced-by: null }`.

```yaml
invariants:
  - "non-leader nodes return early"                  # legacy string form
  - rule: "tenant context cleared in finally regardless of throw"
    enforced-by: TenantContextLeakTest.testClearsAfterException
  - rule: "each tenant runs in REQUIRES_NEW tx"
    enforced-by: null   # asserted by reading the code, not tested
```

**Reference format.** `enforced-by` is a string. Two forms accepted:

- **Symbol form:** `ClassName.methodName` — resolved against the v0.2
  symbol index. Cheap and language-neutral.
- **File-anchored form:** `<path>::<test-name>` — for runtimes whose
  test functions are not first-class symbols in the index
  (vitest/jest `it("…")` strings).

**Enforcement check.** A new command `sivru block check-enforcement
[path]` walks every invariant with a non-null `enforced-by` and
verifies:

1. The referenced test exists (resolves through the symbol index for
   the symbol form; tree-sitter-parses the file for the file-anchored
   form to locate the `it()`/`test()` call by name).
2. The test is not skipped — no `it.skip`, `xit`, `test.skip`,
   `@Ignore`/`@Disabled` annotation, `t.Skip()` in Go, or
   `@pytest.mark.skip` decorator.
3. Out of scope: verifying the test actually asserts the invariant.
   That is read-the-code work that no static check can replace.

Diagnostics in the new `SIVRU-E230` range:

| Code | Severity | Trigger |
|------|----------|---------|
| `SIVRU-E230 enforcement-missing` | error | `enforced-by` reference does not resolve |
| `SIVRU-E231 enforcement-skipped` | error | referenced test is marked skipped |
| `SIVRU-E232 enforcement-unset` | warning | invariant in object form with `enforced-by: null` (turns "I didn't write a test" into a tracked signal — the next test to write) |

`SIVRU-E232` defaults to warning to keep the upgrade path cheap;
projects that want to require enforcement everywhere set it to `error`
via `.sivru/block.json`.

**Why first.** This is the structural fix that the agent identified
as highest leverage. It turns block-level intent into an enforceable
invariant graph: hope → proof.

### 2. Diff-aware "block staleness" detection

A block's invariants could be wrong because the code drifted. Today
there is no signal short of `stale-block` (DESIGN-0017's body-hash
heuristic), which fires on rename and reformatting too — high false
positive rate.

```bash
sivru block staleness --since=origin/main
```

Algorithm (revised at eng-review iter-1 — D3 — to avoid the
hot-path git cost flagged by prior learning
`product-decisions-can-hide-hot-path-git-costs`):

```
sivru block staleness --since=<ref>
  │
  ├─ run `git diff --name-only <ref>...HEAD` → changed files
  │
  ├─ ensure index is current for <ref> (background refresh if stale)
  │
  ├─ for each changed file:
  │   ├─ read pre-diff block ranges + content hashes from the
  │   │  v0.2 symbol index (one cheap lookup per file; no
  │   │  git show, no re-parse)
  │   ├─ extract current @sivru blocks (tree-sitter, in-memory)
  │   ├─ for each (pre-block, current-block) pair:
  │   │   ├─ if content hash matches AND `git diff --unified=0
  │   │      <ref> -- <file>` has hunks outside the block range:
  │   │      → emit SIVRU-E233 block-likely-stale (warning)
```

**Index extension.** The v0.2 symbol index (which already carries
`symbolName`, `nodeType`, and per-file metadata) gains a per-file
`blocks: { range: [start,end], contentHash: string }[]` array,
populated at index-build time when blocks are extracted. Staleness
check is then index-lookup + per-file extraction + cheap hunk
overlap test. Index entries grow by ~bytes per indexed file — the
overhead is bounded by block density (a file with zero blocks
pays zero cost).

**Why this shape.** Per prior learning: "Always check: does the
sort criterion require per-element work? If so, cache it at
index-build time alongside the data being sorted." Same applies
to drift checks. Adding the cache once in the index avoids paying
N `git show` + N tree-sitter parses on every PR's staleness check.

Not a hard fail (often the block IS still right after a refactor),
but a **focused review checklist** for the PR author. CLAUDE.md item
#3 already asks humans to do this with discipline; this makes it
mechanical.

Output is a markdown table by default (PR-comment-friendly), JSON
behind `--json`. Diagnostics carry the file path and the count of
changed lines outside the block range.

**Relationship to DESIGN-0017's `stale-block`.** DESIGN-0017 plans
a body-hash `stale-block` diagnostic that fires on long-running
drift (the symbol's body changed across multiple commits since the
block's last touch). §2's `block-likely-stale` is the PR-scope
sibling — same drift family, different scan window. The two coexist:
DESIGN-0017's variant runs on demand or in nightly sweeps; §2's
runs in PR CI. Distinct codes (DESIGN-0017's `stale-block` in
`SIVRU-E22X`; §2's `block-likely-stale` in `SIVRU-E233`).

### 3. Cross-block consistency check

Block A says `collaborators: [B, C]`. Block B doesn't mention A. The
claim is one-sided. After a rename, half the graph carries the new
name and half carries the old. A graph walker catches both classes:

```bash
sivru block graph --check
```

Diagnostics:

| Code | Severity | Trigger |
|------|----------|---------|
| `SIVRU-E234 collaborator-asymmetric` | warning | A → B but B → A is absent. Often intentional (e.g., A drives B but B is a leaf utility) — warning, not error, with `--strict` to promote. |
| `SIVRU-E235 collaborator-rename-suspect` | warning | A → "OldName"; "OldName" does not resolve, but a symbol "NewName" exists whose `collaborators` includes A. Suggested rename. |
| `SIVRU-E236 collaborator-order-contradiction` | warning | A says "runs after B"; B says "runs after A" (textual scan of `decisions[].chose` + `invariants[]` for "runs after" / "runs before" — heuristic, opt-in via `.sivru/block.json` `graph.orderingChecks: true`). |

`broken-collaborator` (DESIGN-0017's E220-range diagnostic) is the
single-block-side version of this check and stays at error level. The
graph walker fills the cross-block gap.

Output: a graph summary (counts per diagnostic) plus per-edge details
in markdown or `--json`. The graph itself is buildable via `sivru
block graph --json` without `--check` for tooling that wants to
consume it.

**Complexity.** Graph build is O(N × M) where N is blocked symbols
and M is average `collaborators[]` length. At BuildWright scale
(~500 blocked symbols expected, ~5 collaborators avg) that is
~2,500 edges — well under any perf concern. Symmetry check is
O(E) on edges via a hash-keyed lookup. No need for indexed graph
storage; build in-memory per `block graph --check` invocation.

**Relationship to DESIGN-0017's `broken-collaborator`.**
DESIGN-0017's `broken-collaborator` (single-block-side: A → "X",
"X" doesn't resolve in the symbol index) and §3's
`collaborator-asymmetric` (cross-block: A → B but B → A absent)
are complementary. Both can fire on the same edge; both stay as
distinct diagnostics. `broken-collaborator` is error-level (the
referenced symbol doesn't exist); `asymmetric` is warning-level
(the back-reference may be intentionally omitted).

### 4. Diff-scoped validate (CI speed)

```bash
sivru block validate --changed-since=origin/main
```

Re-parses only the files touched in the diff. Same diagnostics, same
exit code shape as the full `validate`. The full scan stays
available; CI uses the diff-scoped flag for fast feedback, a nightly
job runs the full sweep.

Implementation: a `git diff --name-only <ref>...HEAD` filter wraps
the existing extractor walk. No schema change. Estimated < 1 day of
work.

The same flag attaches to `block check-enforcement`,
`block graph --check`, and `block staleness` (where it is implicit) —
all read the same changed-file list.

### 5. Multi-path CLI (quality-of-life bug)

```bash
sivru block validate path1 path2 path3
```

Today: silently shows help, exits non-zero. The fix is in the
argv parser in `packages/cli/src/commands/block.ts`. All paths
walked; results merged; single exit code reflects the worst
diagnostic across all paths.

This ships in the first release that touches the block CLI — likely
folded into the v0.8 surfacing work or the first reliability slot,
whichever lands earlier. It is a 30-minute fix.

### 6. `revisit-if` as a watchable predicate — *deferred*

> **Deferred to a follow-on design (DESIGN-002X, name TBD) per
> eng-review iter-1 scope reduction.** Reason: the most ambitious
> item (external Prometheus dep, threshold mini-language, issue-
> opening, adapter pattern) is also the one with the least field
> data behind it. Decisions stay prose-only until slots 1–4 ship and
> usage tells us whether projects actually want a watcher. Prose
> `revisit-if` is not silently lying — a human or agent reading the
> block can judge the condition — so the cost of waiting is low.
>
> Original idea preserved here for the follow-on: extend
> `revisit-if` to accept an object form with `prose + metric +
> threshold` or `prose + check`; ship a `sivru decisions
> stale-check` command driven by a Prometheus adapter; let other
> sources (Grafana, Datadog, CloudWatch) ride as separate add-on
> packages.
>
> The forward-pointer goes in this design's "Open questions"; the
> design itself does not commit to this slot.

### 7. Block scaffolding

```bash
sivru block init path/to/File.ts                 # stdout, dry-run
sivru block init path/to/File.ts --write         # insert into source
sivru block init path/to/File.ts --symbol=Foo    # specific target
```

Generates a starter block from:

1. **Symbol name + existing doc comment** — extracts the first
   sentence of the JSDoc/TSDoc/Javadoc/godoc/docstring as the
   `responsibility` default.
2. **Import graph** — files imported by this file that resolve to
   symbols in the v0.2 index become candidate `collaborators`,
   ranked by import-graph centrality. Top 3–5 pre-populated.
3. **Heuristic `role`** — pulled from class-name suffix patterns
   (`*Service`, `*Repository`, `*Router`, `*Reranker`) when present;
   else left as `TODO`.
4. **TODO scaffolding** — `invariants` and `decisions` ship with
   `TODO:` placeholders the author replaces; `maturity: experimental`
   default (forces an explicit promotion).

Output example for `HybridRetriever.ts`:

```yaml
@sivru
schema: 1
role: retrieval-pipeline   # heuristic: *Retriever
responsibility: "TODO: one-sentence role in the system"
collaborators:
  - BM25Index
  - VectorStore
  - CustomerMatchReranker
invariants:
  - rule: "TODO: claim that must hold"
    enforced-by: null
decisions:
  - chose: "TODO"
    because: "TODO"
    valid-while: "TODO"
    revisit-if: "TODO"
maturity: experimental
@end
```

`--write` inserts the block at the correct attachment point per
language (above the declaration in TS/JS/Java/Go; inside the
function/class body as a docstring in Python). The CLI checks for an
existing `@sivru` block on the target symbol and refuses to
overwrite without `--force`.

**Why this is a small release on its own.** Authoring ergonomics is a
distinct axis from validation. It also unblocks the codebase
explainer (DESIGN-0018) — first-time block authoring at scale
benefits from scaffolding.

### 8. Language coverage hardening

Carrier-attachment gaps across five languages, ranked by real-usage
frequency:

- **Java records and enums (highest impact).** Hit 3 times in 24
  Java blocks; a real blocker, not a polish item. Java records
  (since 16) and enums are legitimate class kinds and their JavaDoc
  placement is identical to a class — the chunker's declaration
  walker must accept them as block hosts. Nested enums inside an
  outer class get their own host (today the block lands on the
  outer class, hiding the contract). Fixtures:
  - `record MemoryWriteScope(…) { /** @sivru ... @end */ }`
  - `public enum HookEvent { /** @sivru ... @end */ ... }`
  - `class Foo { /** @sivru ... @end */ enum Bar { … } }` (nested
    enum gets its own block, distinct from `Foo`'s)
- **Java `package-info.java` (module-level).** DESIGN-0016 §3
  deferred Java module-level to v0.6.x. This slot ships it.
  `package-info.java` carries package-level JavaDoc (Java's
  package documentation convention); the module locator scans for a
  top-of-file `/** ... */` comment containing a `@sivru`/`@end`
  fence, same shape as the TS top-of-file pattern. Package-wide
  contracts (e.g., "every entity here is tenant-scoped; never
  disable the filter") finally have a host.
- **Java inner classes and sealed types.** Inner classes
  (`Outer.Inner`) and member types in general get their own
  block-attachment site when they carry their own JavaDoc — they
  are not absorbed by the outer class's block. Sealed interfaces
  and sealed classes (since Java 17) likewise. Fixtures + spec
  added; behavior matches the existing class case.
- **TS records and enums.** Per batch A — TS `type` aliases,
  `interface` declarations, `enum`, and `const` assertions for
  TS-style records. Audit which TS declaration kinds the chunker
  surfaces and fix the gaps. Spec the attachment rules in
  CONTRIBUTING.md.
- **Per-language `block-prose` cap.** The 25-line warning
  threshold (`SIVRU-E211`) is tight for Java verbosity (4
  invariants + 2 decisions × multi-line easily blows 25). Make the
  cap per-language in `.sivru/block.json`:
  ```jsonc
  {
    "maxLines": {
      "default": 25,
      "java": 40,
      "go": 25,
      "python": 30,
      "typescript": 25,
      "rust": 30
    }
  }
  ```
  Existing single-number form (`"maxLines": 25`) stays valid as
  shorthand for `{ "default": 25 }` — backward-compatible.
- **Python and Go per-symbol audit.** Supported per
  `extract.ts:170–174` but real-usage reports gaps. Audit each
  language's declaration kinds the chunker walks and ensure parity
  with TS/JS/Java.
- **Rust net-new.** `///` line-comment carrier. Add the grammar to
  the chunker's supported set; per-symbol blocks on `fn`,
  `struct`, `enum`, `trait`, `impl`.

This is the slowest-to-ship item. The Java carriers (records,
enums, package-info, inner/sealed) are the highest-impact and ship
as one focused slot. Python/Go audits and Rust net-new are smaller;
they ride patch releases between the slots above.

**Block YAML stays language-agnostic.** The work is in the carrier
parser and the attachment-site walker, both of which already live in
the chunker.

### 9. YAML authoring ergonomics (Java idioms)

> **Resumed at eng-review iter-1 (D5)** after the tag-format pivot
> (DESIGN-0020) was rejected. Codex outside-voice review surfaced a
> regression risk (IDE format-on-save tools would silently corrupt
> tag blocks by rejoining continuation lines) that outweighed the
> authoring-ergonomics gain. The agent's friction report stands; the
> answer is YAML hardening + better errors + autofix, not a format
> pivot. See [DESIGN-0020](0020-tag-based-block-format.md) for the
> full rejection rationale.

Authoring 24 Java blocks surfaced three YAML failure modes the
parser punishes harshly. All three are about prose strings; all
three have low-cost fixes that meet authors where they write.

**9a. Colon-in-prose: clearer error + autofix lint (not a parser
deviation).** YAML's bare-string support stops at `:`. Java JavaDoc
carries `key: value`, `tx: REQUIRES_NEW`, `@Inject: …` constantly,
so invariant prose collides with YAML mapping syntax on the first
try. The workaround today is `"…"`-wrapping every line — visible
noise, easy to forget on the fourth invariant.

Fix: keep block format as **standard YAML**; do not deviate the
parser. Instead:

1. **Clearer error.** When js-yaml fails on an unquoted colon
   inside a value that is structurally an array item under
   `invariants:` or a string scalar under `decisions[].chose /
   because / valid-while / revisit-if`, wrap the diagnostic:

   ```
   SIVRU-E237 yaml-colon-in-prose: unquoted ':' in prose field at
   `invariants[1]`. Wrap the value in double quotes: "tx: REQUIRES_NEW
   per-row failure does not abort the run". Auto-fixable via
   `sivru block validate --autofix`.
     line 14:   - tx: REQUIRES_NEW per-row failure does not abort the run
                    ^
   ```

2. **`sivru block validate --autofix`.** A new flag on the
   existing `block validate` command. When the failing block can
   be safely rewritten by adding double-quotes around the
   offending value, the autofix edits the file in place. Idempotent
   (re-running is a no-op once fixed). Refuses to autofix if the
   value already contains `"` characters that would require
   escaping — those need human review.

Architectural rationale: keeps block YAML compatible with every
external YAML tool (IDE plugins, format tools, jsdoc-yaml readers).
The author pays a one-time cost on the first colon-in-prose; the
autofix removes the friction of repeating the manual quoting work.
The error message names the exact line and the exact fix.

Rejected alternative: a free-text-list parser for `invariants:` /
`decisions[].chose/because/…`. Considered at eng-review iter-1 and
rejected — see Alternatives Considered. The deviation is too costly
relative to the gain when a one-time-learning autofix solves the
same problem.

**9b. Apostrophe-comma error clarity.** `'this.commit()'` parses as
a single-quoted string; a later comma on the same line triggers
"mapping entry not allowed here" — js-yaml's stock error points at
the comma, not the unterminated apostrophe.

Fix: post-process js-yaml errors. When the failing line contains
unbalanced apostrophes around an identifier-like token (regex
`'[\w.()$]+'`), wrap the diagnostic:

```
SIVRU-E238 yaml-quote-context: apostrophes around 'this.commit()'
look like a YAML single-quoted string. Wrap the whole value in
double quotes ("this.commit()") or escape the apostrophes (''). Run
`sivru block validate --autofix` to apply the double-quote rewrite.
  line 14: chose: 'this.commit()' direct, no proxy
                  ^^^^^^^^^^^^^^^
```

The original js-yaml error is preserved underneath for debugging.
The `--autofix` from §9a covers this case as well.

**9c. `maturity` "did you mean".** `maturity: beta` rejected with a
flat enum-mismatch message. Authors who live in alpha/beta/GA
vocabulary pay 30 seconds of confusion every time. Cheap fix:
Levenshtein-distance suggestion in the `SIVRU-E213` error message
("did you mean `experimental`?"). ~3 lines of code; applies to any
locked-enum diagnostic (today only `maturity`).

**Diagnostic additions:**

| Code | Severity | Trigger |
|------|----------|---------|
| `SIVRU-E237 yaml-colon-in-prose` | error | Wrapped js-yaml error pointing at an unquoted colon inside an `invariants:` or `decisions[].chose/…` value. Autofix-capable via `--autofix`. |
| `SIVRU-E238 yaml-quote-context` | error | Wrapped js-yaml error with apostrophe-balance hint (`'this.commit()'` and similar). Autofix suggests double-quoting the value. |

The did-you-mean suggestion (§9c) adds no new diagnostic code —
it is a message improvement on existing `SIVRU-E213`.

### 10. Language-signal bridges (annotation/JavaDoc → block)

The under-leveraged opportunity. Code already carries machine-
readable signals that mean things; the block author repeats them.

**10a. Annotation → invariant suggestions.** A small built-in
catalog of common Java annotations maps to canonical invariant
strings:

| Annotation | Suggested invariant |
|---|---|
| `@ApplicationScoped` | "thread-safe; no instance state" |
| `@Singleton` | "thread-safe; no instance state" |
| `@RequestScoped` | "one instance per HTTP request" |
| `@Transactional` | "must be called via CDI proxy; never `this.method()`" |
| `@Filter("tenantFilter")` (Hibernate) | "tenant-scoped; JPQL only" |
| `@Audited` (Envers / project-defined) | "every call writes an audit row" |
| `@SecurityChecked` | "RBAC enforced at entry" |
| `@Retryable` (Spring/MicroProfile) | "idempotent; safe to re-run on failure" |

The catalog is language-keyed. Other languages get their own
catalogs over time:

- **Python:** `@dataclass(frozen=True)` ⇒ "immutable; equality by
  field"; `@app.route(...)` ⇒ "HTTP entry point";
  `@pytest.fixture` ⇒ "test-only construction".
- **TS/JS:** `@Injectable()` (Angular/Nest), `@Component()`,
  `@Module()`, decorators-stage-3 patterns.
- **Go:** build tags (`//go:build linux`) carry constraint
  invariants; struct tags (`json:"-"`) carry contract facts.

Catalogs live in `packages/search/src/block/bridges/<lang>.ts` and
are user-extensible per CONTRIBUTING.md (declarative override +
code-level extension).

**10b. Two surfaces consume the catalog.**

- **`sivru block init` (§7) pre-fills.** Scaffolding reads the
  symbol's annotations and includes matching invariants as part of
  the generated block. Author confirms or strikes. Per the agent's
  report: "Cost per block drops 50%, accuracy goes up."
- **`sivru block check-bridges` (new command).** Walks every
  blocked symbol; flags annotations whose canonical invariant is
  not present in the block. Default: warning (the author may have
  rejected the suggestion intentionally). Diagnostic
  `SIVRU-E239 bridge-suggestion`.

**10c. JavaDoc `@deprecated` ↔ block `maturity: deprecated`.** A
specific case of the same principle. Two surfaces, one fact;
keep them in sync. Severity is direction-asymmetric because the
two surfaces have asymmetric authority:

- **Direction A: JavaDoc has `@deprecated`, block disagrees.**
  `SIVRU-E260 deprecated-maturity-mismatch` (error). JavaDoc
  `@deprecated` is the load-bearing signal — Javadoc-aware tools
  (IDE warnings, deprecation reports, downstream consumers) read
  it. A block that says `maturity: stable` while JavaDoc says
  `@deprecated` lies to the agent. Fix: remove the JavaDoc tag, or
  set `maturity: deprecated`.
- **Direction B: block has `maturity: deprecated`, JavaDoc silent.**
  `SIVRU-E260 deprecated-maturity-mismatch` (warning). The block's
  intent is right, but the JavaDoc surface is missing — IDEs and
  external tools won't see the deprecation. Author should add
  `@deprecated` to JavaDoc.
- **Both directions wrong (e.g., block `experimental` + JavaDoc
  `@deprecated`, or block `deprecated` + JavaDoc `@since`-without-
  deprecation):** treat as direction A (the JavaDoc is the
  authority for this signal).

`@since` ↔ a future `since:` block field (not in v0.6; reserved
for a later slot). Out of scope for the first slot; tracked in
open questions.

**10d. Why this is its own slot.** Annotation catalogs are
language-keyed; the bridge mechanism is general; the consumer
surface is two commands (`init`, `check-bridges`). Big enough to
deserve focus, small enough to ship in one release. Pairs
naturally with §7 (scaffolding) — together they make first-time
block authoring ~50% cheaper.

### 11. Generated code — block-by-reference (research)

Lombok generates builders. Hibernate generates runtime proxies.
MapStruct generates mappers at build time. Quarkus synthesizes
beans at build time. When the load-bearing thing is the generated
impl (e.g., `SolutionMapperImpl`), there is no source file to
host a `@sivru` block.

Three candidate mechanisms, all marked **research / open** for now:

**11a. Block-on-source, reference-by-pattern.** A block on the
annotated source class declares a `generated:` reference:

```yaml
@sivru
role: tenant-mapping
responsibility: ...
generated:
  - pattern: "**/SolutionMapperImpl.java"
    reason: "MapStruct generates impl at build time; this block
      describes the contract the impl must satisfy"
@end
```

Validation walks the pattern; if no generator matches, warns. The
block "covers" the generated impl by reference, surfaced in
`sivru explain` against the generated symbol.

**11b. Annotation-on-generator marker.** A repo-level mapping in
`.sivru/block.json`:

```jsonc
{
  "generated": {
    "annotations": [
      { "marker": "@Mapper", "covers": "${type}Impl" },
      { "marker": "@Builder", "covers": "${type}Builder" }
    ]
  }
}
```

`sivru explain SolutionMapperImpl` walks back to the `@Mapper`-
annotated source and surfaces that block.

**11c. Punt — declare out of scope.** Accept that generated code
is unblocked; ensure the agent reading `explain` on a generated
symbol sees a clear "this is generated, see <source>" pointer
derived from imports/inheritance.

**Decision: defer.** This needs more real-world data on which
generator patterns matter most. Track as a follow-on after slots
1–5 ship. Initial implementation likely picks 11a + 11c hybrid —
explicit `generated:` reference on the source block, with the
explain surface walking generator metadata when present.

## Release plan

Per principle 1 ("Small releases. One focus per version, 1–4 weeks of
work") and principle 2 ("Feedback between releases — adapt v(N+1)
scope after v(N) ships"). The default split below is a proposal; the
slots are loose and the next firm slot is whichever this design lands
in.

| Slot (proposal) | Capabilities | Why grouped | Est. |
|---|---|---|---|
| **Slot 1 (e.g. v0.10.0) — provable claims + ergonomics** | (1) invariant→test linkage + (4) diff-scoped validate + (5) multi-path CLI + (9) YAML authoring ergonomics + (4b) `maturity` did-you-mean | Shared CI-shape change AND the quick authoring-ergonomics fixes that the second-batch agent hit on day one. Multi-path, did-you-mean, and the YAML colon/quote handling are 30-min to 1-day each — folding them in here means the next agent does not eat the same papercuts. | ~3w |
| **Slot 2 (e.g. v0.11.0) — drift surfaces** | (2) diff-aware staleness + (3) cross-block consistency | Both are drift surfaces; both consume the same diff+graph plumbing. Ship together so the PR-review story is coherent. | ~2w |
| **Slot 3 (e.g. v0.12.0) — authoring leverage** | (7) block scaffolding + (10) language-signal bridges | Scaffolding without the annotation→invariant catalog is 50% of the value; with it, the cost-per-block roughly halves per the agent's own report. They ship together so first-time block authoring is as cheap as possible by the time DESIGN-0018 (codebase explainer) lands and asks for bulk authoring. | ~3–4w |
| **Slot 4 (e.g. v0.13.0) — language carriers** | (8) Java records/enums + `package-info.java` + inner/sealed + TS records/enums + per-language `maxLines` | Carrier-attachment audit consolidated into one focused release. Java is the highest-impact slice (the second-batch repro). | ~2–3w |
| **Deferred** | (6) watchable `revisit-if` | Most ambitious item; needs field data from slots 1–4 before committing. Tracked as DESIGN-002X follow-on. | — |
| **Patch series (interleaved)** | (8) Python per-symbol audit, Go per-symbol audit, Rust net-new | One sub-release per language; none blocks the others. | ~1w each |
| **Open / research** | (11) generated code — block-by-reference | Needs more real-world data. Tracked as a follow-on; revisit after slots 1–5 ship and the bridges from §10 are in field. | TBD |

**Slot independence (added at CEO-review iter-1).** Slots 3 and 4
are independent of slots 1 and 2 — different module touch points
(bridges/scaffolding + chunker carriers vs validation + symbol
index). If BuildWright-style adoption demand surfaces and Java
carrier gaps become urgent, slot 4 can ship before slot 2 or 3.
Slot 1 stays first because it carries the highest-leverage
invariant→test work and the shared `--changed-since` plumbing
that slot 2 consumes.

**Sequencing rationale.**

- **Slot 1** ships invariant→test linkage (the structural fix) and
  *all* the small ergonomics fixes the batch-B agent reported (multi-
  path, YAML colon-trap, apostrophe-comma error, did-you-mean). The
  ergonomics items are tiny individually but combine into "the next
  author does not re-hit these"; deferring them is false economy.
- **Slot 2** is unchanged from the original plan — drift surfaces
  layered on top of provable claims.
- **Slot 3** combines scaffolding with the annotation→invariant
  bridge. The agent's report was explicit that scaffolding pre-
  filled from imports + annotations cuts authoring cost ~50%. They
  share a release because scaffolding without the catalog is
  half-built; the catalog without scaffolding is a check-only
  feature with no authoring win.
- **Slot 4** ships the Java carrier gaps (records, enums, package-
  info, inner/sealed) together with TS records/enums and per-
  language line caps. This is the second-highest-impact slice from
  batch B (after the YAML traps, which ride slot 1). One focused
  release is cleaner than one-per-language patches because the work
  shares fixtures and the chunker's declaration walker.
- **Deferred:** watchable `revisit-if` — eng-review iter-1 cut. The
  follow-on design owns Prometheus integration, threshold mini-
  language, and the decision-checker adapter pattern when field
  data from slots 1–4 justifies the scope.

**Interaction with DESIGN-0017 (v0.8).** DESIGN-0017 ships first
(serving + four baseline drift diagnostics). DESIGN-0019 is the layer
on top — it does not supersede DESIGN-0017's drift detection; it
extends it with new dimensions (test linkage, diff-awareness, graph,
language-signal bridges). The error-code ranges below preserve the
partition.

## Error-code range partition

Extending the partition from DESIGN-0016 §4. Codes are claimed by
slot, not by file order; the slot a code lands in is the version
that introduces the diagnostic.

- **v0.6:** `SIVRU-E210–E219` (block schema + extraction)
- **v0.7:** `SIVRU-E220–E229` (DESIGN-0017 baseline drift)
- **Slot 1:** `SIVRU-E230–E239` (this design — enforcement +
  YAML ergonomics)
- **Slot 2:** `SIVRU-E250–E259` (this design — staleness + graph)
- **Slot 3:** `SIVRU-E260–E269` (this design — annotation/JavaDoc
  bridges)
- **Slot 4:** `SIVRU-E270–E279` (this design — carrier coverage)
- **DESIGN-0018 (codebase explainer):** `SIVRU-E240–E249`
- **Deferred (DESIGN-002X — watchable decisions):** `SIVRU-E290–E299` reserved
- **Reserved future:** `SIVRU-E280+`

Codes claimed by this design:

| Code | Slot | Severity | Trigger |
|---|---|---|---|
| `SIVRU-E230 enforcement-missing` | 1 | error | `enforced-by` reference does not resolve |
| `SIVRU-E231 enforcement-skipped` | 1 | error | referenced test is marked skipped |
| `SIVRU-E232 enforcement-unset` | 1 | warning | invariant object form with explicit `enforced-by: null` |
| `SIVRU-E233 block-likely-stale` | 2 | warning | diff-aware staleness signal |
| `SIVRU-E234 collaborator-asymmetric` | 2 | warning | A → B but B → A absent |
| `SIVRU-E235 collaborator-rename-suspect` | 2 | warning | rename heuristic match |
| `SIVRU-E236 collaborator-order-contradiction` | 2 | warning (opt-in) | textual A-after-B vs B-after-A conflict |
| `SIVRU-E237 yaml-colon-in-prose` | 1 | error | wrapped js-yaml error pointing at an unquoted colon in `invariants`/`decisions[]` prose; autofix-capable |
| `SIVRU-E238 yaml-quote-context` | 1 | error | wrapped js-yaml error with apostrophe-balance hint; autofix-capable |
| `SIVRU-E239 bridge-suggestion` | 3 | warning | annotation suggests an invariant not declared in the block |
| `SIVRU-E260 deprecated-maturity-mismatch` | 3 | error / warning | JavaDoc `@deprecated` vs block `maturity` out of sync (direction-dependent severity per §10c) |
| `SIVRU-E270 carrier-attachment-failed` | 4 | warning | block fence detected in a comment that did not attach to a recognized declaration (records/enums/inner/sealed without parser support) — emitted *only* for the slot-4 audit; long-term, attachment should always succeed |

## Alternatives considered

**Hard-fail CI on every drift signal.** Rejected per the same
reasoning in DESIGN-0017 — body-hash staleness and graph asymmetry
are heuristics. Hard-failing on a heuristic trains users to ignore
the signal. Stick to warnings for heuristic checks; reserve errors
for resolved-or-not-resolved facts (enforcement missing, broken
collaborator).

**LLM-judged invariant enforcement** ("does this test actually assert
this invariant?"). Rejected for the same reason DESIGN-0017 rejected
LLM-judged staleness: violates the local-first boundary, and the
verdict belongs to the agent reading the block in context, not to
sivru. Sivru gives the agent inputs; the agent makes the judgment.

**Inline tests inside blocks** (the block declares the assertion in
YAML and sivru runs it). Rejected: blurs the runtime/test boundary,
duplicates test-framework semantics inside YAML, and disincentivizes
real test coverage. The `enforced-by` reference is the right
abstraction — it points at a real test in the real test runner.

**Auto-rewrite blocks on rename** (track symbol renames in git and
rewrite `collaborators`). Rejected for v0.X: tempting but invasive.
The graph check surfaces the asymmetry; the human (or agent) makes
the rewrite. Auto-rewrite is a candidate beyond v1.0 once the rename
detector has field data.

**Sidecar `block.lock` file** (cache last-known block content +
hashes for diff-awareness). Rejected: re-introduces the sidecar
drift problem that `@sivru` blocks solved in the first place. Git
already has the data we need (`git show <ref>:<file>`); use it.

**Custom mini-language for `enforced-by`** (richer than symbol-path
or file-path). Rejected: two forms is already at the edge of what's
worth it. Anything more goes through the code-level extension layer.

**Free-text-list parser for `invariants` / `decisions[].chose/…`.**
Considered as the §9a fix — parse those specific fields as free-text-
list-of-lines rather than YAML scalars, so authors can write Java
idioms (`tx: REQUIRES_NEW`) without quote-wrapping. Rejected at
eng-review iter-1 (D2). The deviation makes block YAML no longer
"just YAML" — IDE plugins, format tools, and external block readers
would need to know the rule.

**Tag-prefixed block format (DESIGN-0020).** Considered as a deeper
fix to the same authoring friction — replace YAML inside the
`@sivru`/`@end` fence with Javadoc-style `@<tag> <prose>` lines.
Accepted briefly at iter-1 D4, then **rejected at iter-1 D5** after
the codex outside-voice review surfaced that IDE format-on-save
tools (IntelliJ JavaDoc, Prettier-Java, gofmt) re-flow `/** */`
comments and would silently corrupt tag blocks by rejoining
continuation lines. YAML's loud-failure mode beats tags' silent-
corruption mode for the in-comment-carrier context. The §9 YAML
hardening here is the chosen path. See
[DESIGN-0020](0020-tag-based-block-format.md) for the full
rejection rationale and the 11 outside-voice findings that
informed the decision.

**Auto-generate blocks from annotations.** Rejected. The annotation
catalog *suggests* invariants (§10); the author confirms. Auto-
generation without confirmation produces blocks that look right but
omit the project-specific invariants only the author knows. Sivru's
job is to lower the authoring cost, not to bypass authorship.

**Drop the 25-line warning entirely.** Rejected. The cap surfaces
runaway prose; some blocks really are too long. The per-language
override (§8) is the right shape — Java legitimately needs more
room; that does not mean removing the signal for languages where
the cap is correctly tuned.

**Treat generated code as a first-class block host.** Rejected for
now (§11). Generated files are rewritten on every build; a block
on them does not survive. The block-by-reference shape (§11a)
preserves the contract on a stable surface (the annotated source)
while making the generated impl explain-able.

## Open questions

- **Should `enforcement-unset` (SIVRU-E232) default to warning or
  silent?** Lean: warning. Turns "no test yet" into a tracked signal
  the next test to write. Counter-argument: every legacy
  string-form invariant becomes a warning on upgrade. Mitigation:
  string-form invariants do NOT trigger E232 (they had no opportunity
  to declare `enforced-by`); only the object form with explicit
  `null` does. (owner: @pochadri, by first-slot kickoff)
- **`enforced-by` resolution path for vitest/jest `it("…")`
  callsites.** Symbol form fails (the `it` callsite is not a
  declaration). File-anchored form requires a tree-sitter walk to
  find the `it("name", …)` call by name. Spec out the parser path
  before first-slot lock. (owner: @pochadri)
- **Diff-aware staleness false-positive rate on rename PRs.** A pure
  rename touches the file but does not invalidate the block. The
  body-hash signal would also fire here. Need a heuristic to suppress
  rename-only changes. (owner: @pochadri, by second-slot kickoff)
- **Should scaffolding pull `responsibility` from existing
  doc-comment prose, or always leave a TODO?** Lean: pull the first
  sentence as a draft; mark it `# auto-generated, replace` so review
  catches it. (owner: @pochadri, by third-slot kickoff)
- **Schema version bump trigger.** Invariants gaining the object
  form, decisions gaining the object form on `revisit-if` — both
  additive per DESIGN-0016 §5 (existing string form still parses).
  Stay at `schema: 1` across all four slots. Confirm at first-slot
  lock that no slot's contract change crosses the breaking-line.
- **Per-language audit findings.** Run the audit before scoping (8);
  the work split between sub-releases depends on which language has
  the most carrier-attachment gaps.
- **`--autofix` safety (§9a).** The autofix rewrites the file
  in place. Confirm the safety rules before slot-1 lock:
  (a) refuse to autofix if the value already contains `"`;
  (b) preserve trailing whitespace and indentation exactly;
  (c) the autofix is opt-in (`--autofix` flag), never the default;
  (d) refuse to autofix files with uncommitted changes
  (`git status --porcelain <file>` not empty) unless `--force` is
  passed — protects against autofix overwriting in-progress edits.
  (owner: @pochadri, by slot-1 kickoff)
- **YAML-quote-context heuristic FP rate (§9b).** The apostrophe-
  imbalance check might fire on legitimate single-quoted YAML
  strings the author meant. Validate on the batch-B blocks
  (24 Java + 32 TS) before locking. (owner: @pochadri, by
  slot-1 kickoff)
- **Block-content protection against IDE formatters (raised by
  codex outside-voice).** YAML in `/** */` is less fragile than
  tag format under format-on-save, but not immune — a re-flow that
  shifts indentation can still break YAML. Consider documenting a
  `// @sivru:no-reformat` marker convention or relying on the fence
  itself as a signal to format-aware tooling. (owner: @pochadri,
  by slot-1 kickoff)
- **Annotation catalog seed scope (§10a).** First release ships a
  Java catalog (eight annotations listed). Should it also ship
  Python / TS / Go catalogs in slot 3, or stage them across patches?
  Lean: Java + Python in slot 3 (highest-coverage languages), TS +
  Go in patches. (owner: @pochadri, by slot-3 kickoff)
- **`@deprecated` ↔ `maturity` failure modes (§10c).** JavaDoc
  `@deprecated` can be tag-only or carry a `(since = "x")`
  argument. The bridge needs to handle both. TS / Python /
  Go have their own deprecation conventions (`@deprecated` JSDoc
  tag, `@deprecated` Python `warnings.warn(DeprecationWarning)`,
  Go `// Deprecated:` comment) — handle in the same slot or stage
  per language? (owner: @pochadri, by slot-3 kickoff)
- **Generated-code mechanism choice (§11).** Defer until after
  slots 1–5 ship and field data exists. The current "research"
  status is correct; revisit at slot-6 planning.
- **`since` field on blocks.** A `since:` field paired with the
  JavaDoc `@since` tag is a natural §10 extension but not in any
  of the five slots. Add to v1.0 wishlist or fold into a slot-3
  patch.
- **CLI surface growth (CEO-review iter-1).** `sivru block` grows
  to 6 subcommands across the 4 slots. The cluster reads well today
  (`validate`/`extract`/`check-enforcement`/`staleness`/`graph`/
  `init`/`check-bridges`) but watch for over-loading. Consider a
  short-form alias scheme (`sivru bv`, `sivru bg`) if discoverability
  feedback shows up post-slot-2. Not blocking; revisit at slot-3
  kickoff.
- **Path dependency for format pivots (CEO-review iter-1).**
  DESIGN-0020 (tag format) was rejected at eng-review iter-1, but
  the question may revisit later. After slot 3 ships annotation
  catalogs that encode semantics in YAML, any future format pivot
  becomes incrementally harder (more meaning baked into the YAML
  shape). Acceptable cost — slot 3 is high-leverage — but worth
  naming so future-us doesn't forget. Not blocking.
- **Adoption-bet acknowledgement (CEO-review iter-1).** DESIGN-0019
  presupposes block adoption grows once DESIGN-0017 (surfacing) and
  DESIGN-0018 (explainer) ship. If adoption stays flat — only
  BuildWright-style early adopters — the 9w reliability investment
  is over-engineered for the actual user base. Track block authoring
  signals (count of `@sivru`-blocked symbols in public sivru users'
  repos, where observable) after DESIGN-0017 ships; revisit
  slot-2/3/4 scope if the signals don't materialize.

## Acceptance criteria (by slot)

### Slot 1 — provable claims + ergonomics

**Invariant → test linkage:**

- Invariants accept both string and object form; object form
  supports `rule` (required) and `enforced-by` (string | null).
- `sivru block check-enforcement [path]` emits `SIVRU-E230` /
  `SIVRU-E231` / `SIVRU-E232` per the diagnostic table; exits
  non-zero on any error.
- Dogfood: every `@sivru` block in `packages/search/` with an
  invariant carries `enforced-by` (or explicit null) by ship time.
  CI gate: enforcement-missing count = 0 on the self-dogfood set.

**Diff-scoped + multi-path CLI:**

- `--changed-since=<ref>` flag works on `block validate`, `block
  check-enforcement`, and (when shipped) `block staleness`, `block
  graph --check`.
- `sivru block validate path1 path2 path3` walks all paths; exit
  code is max severity across all paths.

**YAML authoring ergonomics:**

- `SIVRU-E237 yaml-colon-in-prose` fires when js-yaml errors on an
  unquoted colon inside an `invariants:` or `decisions[].chose/…`
  value. Error names the line and the exact fix.
- `SIVRU-E238 yaml-quote-context` fires when js-yaml errors on a
  line with unbalanced apostrophes around an identifier-like token;
  the wrapped error names the apostrophes and the original error
  is preserved underneath.
- `sivru block validate --autofix` rewrites both E237 and E238
  cases by adding double-quotes around the offending value.
  Idempotent. Refuses to autofix values containing `"` that would
  require escaping.
- `SIVRU-E213 maturity-invalid` carries a Levenshtein-distance
  suggestion ("did you mean `experimental`?") when the supplied
  value is within distance 3 of a valid value.
- Dogfood: the 24-block BuildWright corpus is re-imported. Initial
  `block validate` shows the colon-trap errors with the new
  message; `--autofix` resolves them in one pass; the re-validated
  corpus is clean.

### Slot 2 — drift surfaces

- `sivru block staleness --since=<ref>` reports files where code
  changed outside the block range AND the block content is byte-
  identical. Exits zero (warning-only). `--strict` exits non-zero.
- `sivru block graph --check` reports `SIVRU-E234` (asymmetric),
  `SIVRU-E235` (rename-suspect), and (opt-in) `SIVRU-E236`
  (ordering-contradiction).
- `sivru block graph --json` emits the full graph without check
  filtering, for external tooling.
- Dogfood: cross-block graph on `packages/search/` is symmetric;
  any intentional asymmetry is justified in `.sivru/block.json`
  `graph.allowedAsymmetric: ["A->B"]`.

### Slot 3 — authoring leverage (scaffolding + bridges)

**Scaffolding:**

- `sivru block init <file>` emits a starter block to stdout;
  takes `--symbol=<name>` to target a specific declaration;
  `--write` inserts into the source.
- Scaffolding populates `collaborators` from the import graph (top
  N=5 by centrality); populates `responsibility` from doc-comment
  first sentence with an "auto-generated, replace" marker;
  pre-fills `invariants` from the annotation catalog (§10a) when
  the symbol's annotations match.
- Refuses to overwrite an existing block on the target symbol
  without `--force`.

**Language-signal bridges:**

- Annotation catalog ships for Java + Python (see Open Questions
  for scope confirmation). Catalogs live in
  `packages/search/src/block/bridges/<lang>.ts` and are
  user-extensible per CONTRIBUTING.md.
- `sivru block check-bridges [path]` walks every blocked symbol;
  flags annotations whose canonical invariant is not present in
  the block via `SIVRU-E239 bridge-suggestion` (warning by
  default).
- `SIVRU-E260 deprecated-maturity-mismatch` fires when JavaDoc
  `@deprecated` and block `maturity` disagree (direction A: error;
  direction B: warning per §10c).
- Dogfood: scaffold a fresh block on a symbol without one in
  `packages/observe/`; review readability of the generated draft.
  Re-scaffold a Java fixture; confirm `@ApplicationScoped` produces
  a `thread-safe; no instance state` pre-fill.

### Slot 4 — language carriers

**Java:**

- `record Foo(...)` hosts a class-level block on its leading
  `/** ... */` comment, same shape as `class`.
- `enum Foo { … }` hosts a class-level block on its leading
  `/** ... */` comment.
- Nested enum `class Foo { enum Bar { … } }` gets its own block
  attachment site distinct from `Foo`'s.
- `package-info.java` hosts a module-level block on its top-of-
  file `/** ... */` comment; surfaces in `sivru explain` as the
  package-level entry.
- Inner classes (`Outer.Inner`) and sealed types (`sealed
  interface Foo`, `sealed class Bar`) host their own blocks when
  their JavaDoc carries one; documented in CONTRIBUTING.md.

**TypeScript:**

- `type` aliases, `interface` declarations, `enum`, and `const`
  assertions for record-style declarations all host blocks on
  their leading `/** ... */` comment. Audit covers each
  declaration kind with a fixture + round-trip test.

**Per-language line caps:**

- `.sivru/block.json` `maxLines` accepts the object form
  `{ default: 25, java: 40, … }`; existing single-number form
  remains valid.
- `SIVRU-E211 block-prose` consults the per-language threshold;
  documented in CONTRIBUTING.md.

**Patch series (interleaved):**

- Python per-symbol audit: every supported declaration kind (`def`,
  `async def`, `class`) has a block-attachment fixture and round-
  trip test.
- Go per-symbol audit: every supported declaration kind (`func`,
  `type`, top-level `var`/`const`) has a block-attachment fixture
  and round-trip test.
- Rust net-new: `///` line-comment carrier; tree-sitter grammar
  added to the chunker; per-symbol blocks on `fn`, `struct`,
  `enum`, `trait`, `impl`.

## Test plan (umbrella — per-slot detail at slot-kickoff)

This is the umbrella-level test plan. Each slot's PR description
expands these into per-acceptance-criterion test inventory at
slot-kickoff, following the DESIGN-0016 §Test plan pattern.

### Slot 1 — provable claims + ergonomics

- **Unit:** invariant schema parsing — string form parses to
  `{ rule, enforced-by: null }`; object form preserves fields;
  mixed-array of both forms round-trips through `blockToJSON()`.
- **Unit:** enforcement resolution — symbol-form refs resolve via
  the v0.2 index; file-anchored refs resolve via tree-sitter walk
  for vitest/jest/mocha test-name strings.
- **Unit:** skip detection — fixtures per framework (vitest
  `it.skip`, jest `xit`, JUnit `@Disabled`, pytest
  `@pytest.mark.skip`, Go `t.Skip()`).
- **Unit:** `--changed-since` walk — `git diff --name-only` mock;
  fixture repo with 5 files, 2 changed; validator walks only the
  changed 2.
- **Unit:** multi-path CLI — `validate a/ b/ c/` walks all three;
  merged exit code reflects max severity.
- **Unit:** `SIVRU-E213` did-you-mean — `maturity: beta` →
  suggestion "experimental" (Levenshtein distance 3); `maturity:
  gold` (outside distance) → no suggestion.
- **Integration:** self-dogfood — every block in
  `packages/search/`'s 21 dogfood symbols gains an `enforced-by`
  (or explicit null + accepted SIVRU-E232 warning); CI runs
  `block check-enforcement packages/`.
- **Unit:** YAML colon-in-prose autofix (§9a) — fixture with a
  Java idiom (`tx: REQUIRES_NEW`) in an unquoted invariant →
  `SIVRU-E237` fires; `--autofix` rewrites the value to
  `"tx: REQUIRES_NEW …"`; re-validate clean. Refuses to autofix
  when the value contains `"` requiring escapes.
- **Unit:** YAML quote-context wrapper (§9b) — fixture with
  `'this.commit()'` → `SIVRU-E238` fires with the wrapped error
  pointing at the apostrophes; `--autofix` rewrites to
  `"this.commit()"`.

### Slot 2 — drift surfaces

- **Unit:** symbol-index extension — index-build populates the
  per-file `blocks[]` cache; staleness check reads from the cache
  (no `git show` invocation in the per-file path).
- **Unit:** staleness algorithm — fixture pair (before/after) where
  the file diffs outside the block range and the block content
  hash matches → `SIVRU-E233` fires; same pair where the block
  content also diffs → no E233.
- **Unit:** graph asymmetry — fixture pair (A → [B]; B → [C]) →
  E234 fires for A↔B; rename fixture (A → "OldName"; "NewName" has
  → [A]) → E235 fires.
- **Unit:** ordering-contradiction E236 — fixture pair (A says
  "runs after B" in `decisions[].chose`; B says "runs after A") →
  E236 fires only when `graph.orderingChecks: true`.
- **Unit:** `graph.allowedAsymmetric` override — fixture pair
  with declared exception → E234 suppressed for that edge only.
- **Integration:** `block graph --json` output shape — graph
  walker output matches the documented JSON schema.

### Slot 3 — authoring leverage (scaffolding + bridges)

- **Unit:** scaffolding round-trip — scaffold → validate →
  `blockToJSON()` → matches the expected per-fixture shape.
- **Unit:** import-graph centrality — fixture file with N imports;
  scaffolding picks the top-5 most-central as `collaborators[]`.
- **Unit:** Java annotation catalog — 8 seed annotations resolve
  to their canonical invariant strings; missing annotation →
  no suggestion.
- **Unit:** Python annotation catalog — 4 seed decorators resolve.
- **Unit:** `check-bridges` walker — fixture where a Java symbol
  has `@ApplicationScoped` but the block omits "thread-safe; no
  instance state" → `SIVRU-E239` warning fires.
- **Unit:** `SIVRU-E260 deprecated-maturity-mismatch` — direction
  A (JavaDoc deprecated, block stable) → error; direction B
  (block deprecated, JavaDoc silent) → warning; both wrong → error.
- **Integration:** dogfood — scaffold a fresh block on a symbol
  without one in `packages/observe/`; re-scaffold a Java fixture
  with `@ApplicationScoped` and verify the catalog-suggested
  invariant appears.

### Slot 4 — language carriers

- **Unit + fixture:** Java records — `record Foo(...) { /** @sivru
  ... @end */ }` extracts as a class-level block.
- **Unit + fixture:** Java enums — `public enum HookEvent { /**
  @sivru ... @end */ ... }` extracts as a class-level block.
- **Unit + fixture:** nested Java enums — `class Outer { enum Inner
  { /** @sivru ... @end */ } }` extracts a block on `Inner`,
  distinct from any block on `Outer`.
- **Unit + fixture:** `package-info.java` module locator — top-of-
  file `/** @sivru ... @end */` extracts as a `kind: "module"`
  block per the existing TS module-locator shape.
- **Unit + fixture:** Java inner classes and sealed types —
  attachment matches the class case; spec verified.
- **Unit + fixture:** TS records (`type`, `interface`) and `enum`
  declarations attach blocks on their leading `/** ... */` comment.
- **Unit:** per-language `maxLines` — `.sivru/block.json`
  `{ default: 25, java: 40 }` → 30-line Java block warns clean,
  30-line TS block emits `SIVRU-E211`.
- **Integration:** dogfood — re-author the 3 Java workaround
  blocks (`MemoryWriteScope` on its record, `HookEvent` on its
  enum, `SolutionStatus` on its nested enum) on their true hosts;
  re-validation clean.

### Performance gates

- **Slot 1:** diff-scoped validate on a 500-file fixture with 5
  changed files completes in < 200ms (vs. full walk ~2–5s
  baseline). Baseline measured before slot-1 PR opens; the gate
  re-measures.
- **Slot 2:** symbol-index build with `blocks[]` cache adds < 3%
  to total index time on the vitest corpus (same gate shape as
  DESIGN-0016 §performance gate). Graph check on the self-dogfood
  21-block set completes in < 100ms; spec scales linearly to
  ~500 blocks → < 2.5s.
- **Slot 3:** scaffolding on a single symbol completes in < 500ms.
- **Slot 4:** language-coverage audit adds < 5% to total chunker
  + block extraction time on the vitest corpus.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — diagnostic severities per the tables
   above; `SIVRU-E232` defaults to warning;
   `SIVRU-E236 collaborator-order-contradiction` defaults to off.
   `SIVRU-E239 bridge-suggestion` defaults to warning. Per-language
   `maxLines` defaults to `{ default: 25, java: 40, python: 30,
   rust: 30 }`. Java annotation catalog seed listed in §10a;
   Python catalog seed in `bridges/python.ts`.
2. **Declarative override** — `.sivru/block.json` gains:
   ```jsonc
   {
     "enforcement": {
       "requireForObjectInvariants": false   // promote E232 to error
     },
     "graph": {
       "allowedAsymmetric": ["A->B"],        // suppress E234 for these edges
       "orderingChecks": false                // enable E236
     },
     "diff": {
       "defaultSince": "origin/main"          // CI default ref
     },
     "decisions": {                            // reserved for DESIGN-002X
       "metricSources": {}                      // (watchable decisions)
     },
     "bridges": {
       "java": {
         "@CustomAnnotation": "project-specific invariant string"
       },
       "disable": ["@RequestScoped"]          // override-replaces semantics
     },
     "maxLines": {
       "default": 25,
       "java": 40
     },
     "generated": {                            // §11 (research; reserved)
       "annotations": [
         { "marker": "@Mapper", "covers": "${type}Impl" }
       ]
     }
   }
   ```
3. **Code-level extension** — `.sivru/block/*.ts` registers:
   - `EnforcementResolver` — custom test-framework resolvers
     (e.g., a project's homegrown test harness).
   - `DecisionChecker` — `revisit-if` checkers when prom/threshold
     does not fit.
   - `BlockGraphRule` — custom graph-level diagnostics beyond
     E234–E236.
   - `AnnotationBridge` — custom annotation → invariant catalog
     entries that go beyond declarative override (e.g., regex-
     matching, conditional-on-package).

## NOT in scope

Deferred or rejected during this design's iteration. Each line is
the rationale; the explicit non-commitment matters as much as the
commitments.

- **Watchable `revisit-if` predicate.** Deferred at eng-review iter-1
  D1 to a follow-on DESIGN-002X. Reason: most ambitious item; needs
  field data from slots 1–4 before committing to Prometheus
  integration + threshold mini-language + issue-opening.
- **Tag-based block format (DESIGN-0020).** Rejected at iter-1 D5
  after codex outside-voice surfaced IDE format-on-save corruption
  risk. The agent's authoring friction is real but YAML hardening
  (§9) is the chosen response.
- **Generated code block-by-reference.** Tracked as research (§11);
  needs field data on which generator patterns matter most.
- **Live-metric polling adapters beyond Prometheus.** Out of scope
  for the deferred slot 4 even if it revives — separate add-on
  packages.
- **LLM-judged staleness or invariant enforcement.** Violates the
  local-first boundary; sivru gives the agent inputs, not verdicts.
- **Auto-rewrite blocks on rename.** Graph check (§3) surfaces
  asymmetry; the human or agent makes the rewrite.
- **Sidecar `block.lock` files.** Re-introduces the drift problem
  blocks solved in the first place; git is the authority.
- **DESIGN-0017 SKILL.md teaching update at v0.8.** Per D6 — slot 1
  brings the `enforced-by` teaching; v0.8 stays minimal.

## What already exists

Existing code that DESIGN-0019 builds on rather than duplicates.

- **`packages/search/src/block/`** — v0.6 block extraction
  (`extract.ts`), validation (`validate.ts`), JSON serialization
  (`toJSON.ts`), config (`config.ts`). DESIGN-0019 extends:
  - `extract.ts` walks Python / Go / Java / TS / JS per-symbol;
    slot 4 adds Java records/enums/inner/sealed/package-info and
    TS records/enums.
  - `validate.ts` emits SIVRU-E210–E218; slot 1 adds E230–E232
    and E237/E238; slot 2 adds E233–E236; slot 3 adds E239/E260;
    slot 4 adds E270.
  - `toJSON.ts` produces `SivruBlockJSON`; slot 1 extends the
    `invariants[]` shape (additive — string AND object form).
- **`packages/search/src/block/module-locators/{python,typescript}.ts`**
  — v0.6 module-level locators. Slot 4 adds Java
  `package-info.java` locator alongside, sharing the same module
  shape.
- **`packages/search/src/chunker/`** — v0.2 tree-sitter chunker
  (per-symbol Python, Go, Java, TS/JS). Slot 4 leverages the
  existing declaration walker; the work is adding declaration kinds
  the walker recognizes (record/enum/inner/sealed for Java; record-
  style declarations for TS) and a Rust grammar in the patch series.
- **`packages/search/src/types.ts`** — v0.2 symbol index with
  `symbolName`, `nodeType`, per-file metadata. Slot 2 extends the
  per-file entry with a `blocks: { range, contentHash }[]` cache.
  Matches the prior-learning pattern (`commitCount` lives on the
  index entry).
- **`packages/cli/src/commands/block.ts`** — v0.6 `sivru block
  validate` and `block extract` commands. Slot 1 adds
  `check-enforcement` + `--changed-since` + multi-path argv fix +
  `--autofix`; slot 2 adds `staleness` + `graph`; slot 3 adds
  `init` + `check-bridges`.
- **DESIGN-0017 (v0.8) `sivru block check`.** DESIGN-0019 slot 2
  extends this with diff-aware staleness + cross-block graph; the
  baseline `broken-collaborator` / `missing-required` /
  `stale-block` / `expired-decision` from DESIGN-0017 stay as-is.
- **DESIGN-0016's `.sivru/block.json` config.** Slot 1–5 all extend
  this file additively per §Customization shape; no breaking changes.

## Open: relationship to DESIGN-0017, DESIGN-0018, and DESIGN-0020

- **DESIGN-0017 (v0.8 — serving + baseline drift).** Ships first.
  This design does not change DESIGN-0017's contract; it extends the
  drift surfaces with new dimensions. Error-code range partition
  preserves the boundary (E220–E229 for v0.7/v0.8, E230–E270+ for
  this design). **DESIGN-0017's SKILL.md authoring section
  teaches only the v0.6 base schema** (D6) — the `enforced-by`
  field, scaffolding, and bridges are taught when slot 1 / slot 3
  ship. v0.8 readers learn the new shape later through normal
  slot-release docs.
- **DESIGN-0018 (v0.9 — codebase explainer).** First-time block
  authoring at scale is the explainer's friction point. Slot 3
  (scaffolding) should ideally land before or alongside the
  explainer's bulk-authoring push. If timing forces a choice, slot 3
  pulls forward.
- **DESIGN-0020 (Rejected at eng-review iter-1).** Opened at D4 to
  capture the format-pivot question; rejected at D5 after codex
  outside-voice surfaced that IDE format-on-save tools would
  silently corrupt tag blocks. The §9 YAML hardening in this doc
  is the chosen path. DESIGN-0020 is preserved as design history;
  its other surfaced findings (SivruBlock shape extension across
  §1, format-detection ambiguity, DESIGN-0017 sequencing) are
  absorbed into this design's Open Questions and the per-slot
  acceptance criteria.

## Effort (per slot)

| Slot | Item | Working days |
|------|------|--------------|
| 1 | Schema additive (invariant object form) | ~0.5d |
| 1 | `check-enforcement` resolver (symbol + file-anchored) | ~3d |
| 1 | Skip-detection across 5 frameworks | ~2d |
| 1 | `--changed-since` flag wiring | ~0.5d |
| 1 | Multi-path argv fix | ~30min |
| 1 | YAML colon-in-prose error + `--autofix` (§9a) | ~1.5d |
| 1 | YAML quote-context wrapper + autofix (§9b) | ~1d |
| 1 | Maturity did-you-mean (§9c) | ~30min |
| 1 | Dogfood: enforce on 21 self-dogfood blocks + re-run BuildWright 24-block corpus with `--autofix` | ~3d |
| 1 | **Total** | **~12–14d (~2.5–3w)** |
| 2 | Symbol-index extension: per-file `blocks[]` cache | ~1d |
| 2 | Diff-aware staleness algorithm (index-driven) | ~1.5d |
| 2 | Cross-block graph walker | ~2d |
| 2 | Graph diagnostics (E234–E236) + opt-in switches | ~1d |
| 2 | Dogfood + fixtures | ~1d |
| 2 | **Total** | **~6d (~1.5w)** |
| 3 | Import-graph centrality scoring | ~2d |
| 3 | Carrier-aware insertion (`--write`) per language | ~3d |
| 3 | Doc-comment first-sentence extraction | ~1d |
| 3 | Refuse-without-force + tests | ~1d |
| 3 | Java annotation catalog (8 seeds + fixtures) | ~2d |
| 3 | Python annotation catalog (4 seeds + fixtures) | ~1d |
| 3 | `check-bridges` walker + `SIVRU-E239` | ~1.5d |
| 3 | `@deprecated` ↔ `maturity` sync (`SIVRU-E260`) | ~1d |
| 3 | Dogfood | ~1d |
| 3 | **Total** | **~13–15d (~3w)** |
| 4 | Java records carrier + fixtures | ~2d |
| 4 | Java enums + nested enums carrier + fixtures | ~2d |
| 4 | Java `package-info.java` module locator | ~1d |
| 4 | Java inner/sealed audit + fixtures + CONTRIBUTING.md spec | ~1.5d |
| 4 | TS records/enums audit + fixtures | ~2d |
| 4 | Per-language `maxLines` config | ~0.5d |
| 4 | Dogfood: re-author the 3 Java workaround blocks on their true hosts | ~1d |
| 4 | **Total** | **~10d (~2w)** |
| Patch | Python per-symbol audit | ~3d |
| Patch | Go per-symbol audit | ~3d |
| Patch | Rust net-new (grammar + carrier + fixtures) | ~5d |

---

## Notes

This design is **Accepted** (2026-05-26). Eng-review iter-1 PASS
(D1–D7, 11 outside-voice findings absorbed, slot 4 deferred,
DESIGN-0020 rejected). CEO-review iter-1 PASS (HOLD SCOPE,
3 clarifications folded). The doc is implementation-ready for
slot 1.

Next step: open the slot-1 implementation issue and start the build.
Slot 2–4 lock at their own kickoffs.

Remaining iteration concerns (lower-priority, fold at slot kickoff):

1. `enforced-by` reference grammar — symbol-form vs file-anchored
   ordering. Spec at slot-1 kickoff.
2. Block-content protection against IDE formatters
   (`// @sivru:no-reformat` marker or rely on fence). Slot-1
   kickoff.
3. Rename-PR false-positive question for slot 2 (staleness).
4. Slot-3 annotation-catalog scope: Java + Python only, or also
   TS + Go?
5. Slot 4 (formerly slot 5) "Java vs other languages" priority —
   defer to the audit per §8 open question.
6. Generated-code mechanism (§11) stays research until field data
   from slots 1–4 arrives.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (iter-1 PASS) | CLEAR | HOLD SCOPE; 3 clarifications folded (CLI surface growth, path dependency for format pivots, adoption-bet acknowledgement) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 (iter-1 PASS) | CLEAR | 7 decisions resolved (D1–D7), 11 outside-voice findings absorbed |
| Outside Voice | Claude subagent (codex failed) | Independent 2nd opinion | 1 | CLEAR | 11 findings; 1 caused strategic reversal (DESIGN-0020 rejected) |
| Codex Review | `/codex review` | Code-level review | 0 | — | — (no implementation yet) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — (no UI scope) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

### Iteration history

**Eng-review iter-1 (D1–D7):**

| Decision | Topic | Outcome |
|----------|-------|---------|
| D1 | Scope reduction: defer slot 4 (watchable `revisit-if`)? | Defer — needs field data from slots 1–3 first |
| D2 | §9a colon-trap: free-text-list parser vs YAML autofix? | YAML autofix (architectural cleanliness) |
| D3 | §2 staleness git-cost: re-extract per file vs index-cache vs hunk-only? | Index-cache (matches `commitCount` learning) |
| D4 | Tag-format pivot (open DESIGN-0020)? | Yes — open the format question |
| D5 | DESIGN-0020 after outside-voice formatter regression risk? | Cancel — outside-voice finding #4 outweighs authoring gain; resume §9 YAML hardening |
| D6 | DESIGN-0017 SKILL.md teaching at v0.8 for new `enforced-by` field? | Minimal at v0.8; slot 1 brings the teaching |
| D7 | Add `Extends: DESIGN-0016` to header? | Yes — explicit lineage |

**CEO-review iter-1 (D1–D2):**

| Decision | Topic | Outcome |
|----------|-------|---------|
| CEO-D1 | Implementation approach: ship all 4 slots, slim to slot 1, or defer entirely? | A — ship all 4 slots as written |
| CEO-D2 | Review posture for remaining sections | HOLD SCOPE — bulletproof the 4 slots, no new scope |

Three small clarifications folded into the design without per-finding
AUQs (per the workflow-pacing rule after 7 accepted recommendations
in the prior session): `--autofix` dirty-file safety rule; slot
independence note (3/4 can ship out of order); CLI surface growth +
path-dependency + adoption-bet observations added to §Open questions.

### Outside voice (Claude subagent — codex failed with model-config error)

**11 findings surfaced.** D5 reversed D4 in response to finding #4
(comment-formatter regression risk). Other findings absorbed:

- #1 SivruBlock shape extension across §1 noted in DESIGN-0020's
  rejection rationale.
- #3, #5, #10 fence collision + indent ambiguity + first-time
  author cost: each contributed to the rejection of DESIGN-0020.
- #6 YAML survives in comparable tools: the actual lesson is
  "YAML in foreign carriers is fragile, not YAML is wrong"; absorbed
  into §9 framing.
- #7 supersession structure: DESIGN-0020 rejected, so no longer a
  "three current designs" problem.
- #8 DESIGN-0017 sequencing: resolved at D6.
- #9 mixed-format-in-one-PR: moot after DESIGN-0020 rejection.
- #11 schema field disappearance: moot.

### CROSS-MODEL: 1 consequential disagreement, 1 reversal.

D4 (open DESIGN-0020) was reversed at D5 after outside voice
surfaced finding #4. Cross-model alignment AFTER the reversal is
strong — both reviewers agree that YAML hardening within DESIGN-0019
§9 is the right path, not a format pivot.

### UNRESOLVED: 0 decisions left hanging.

All seven AUQs answered. Six lower-priority follow-ups tracked in
this design's `## Notes`.

### VERDICT

**CLEARED — CEO + ENG.** Eng-review iter-1 PASS, CEO-review iter-1
PASS. DESIGN-0019 is implementation-ready. Scope locked at 4 slots
(slot 1 → 2 → 3 → 4, with slots 3/4 free to ship out of order if
priority demands).

**Next steps:**

1. Promote Draft → Accepted (header status edit).
2. Open the slot-1 implementation issue. Slot-1 effort:
   ~12–14d (~2.5–3w).
3. Create the worktree + feat branch off main for slot-1 work
   when ready.
4. Track block-adoption signals post-DESIGN-0017 ship; revisit
   slot-2/3/4 scope if adoption doesn't materialize (per the
   adoption-bet acknowledgement in §Open questions).
