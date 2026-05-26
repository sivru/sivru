# DESIGN-0020: Tag-based block format — `@sivru` schema:2

**Status:** Rejected at eng-review iter-1 (2026-05-26) — see "Rejection rationale" below.
**Class:** Spine (per [GOALS.md](../../GOALS.md) — the carrier format
of authored context, the comprehension layer's most-touched surface)
**Targets:** N/A (rejected)
**Issue:** N/A
**Created:** 2026-05-26
**Rejected:** 2026-05-26
**Author:** @pochadri

## Rejection rationale

Proposed at DESIGN-0019 eng-review iter-1 (D4) in response to
real-usage feedback that YAML was structurally wrong for in-comment
authored context. The format pivot was accepted on the strength of
the authoring-ergonomics argument.

Outside-voice review (Claude subagent, 2026-05-26) surfaced 11
substantive findings that the eng-review missed. The load-bearing
one was **comment-formatter interaction**: IDE format-on-save
tools (IntelliJ JavaDoc, Prettier-Java, gofmt, ruff-format) re-flow
`/** */` comments. They preserve `@param`/`@return` as block markers
but will not preserve `@invariant`/`@calls`/`@decision` — they
rejoin continuation lines and silently corrupt the block. YAML
inside the fence at least fails *loudly* when reformatted; the tag
format would fail *silently*.

Decision at iter-1 D5: cancel the format pivot. Resume DESIGN-0019
§9 (YAML hardening — clearer errors + `--autofix`). The agent's
authoring-friction report stands; the answer is YAML hardening +
better error messages, not a format pivot whose silent-corruption
risk under routine formatter passes outweighs the authoring win.

Other outside-voice findings worth preserving for future revisits:

- The SivruBlock canonical shape extends across DESIGN-0019 §1; any
  future format change must absorb those extensions.
- `@end` fence collides with `@<tag>` namespace.
- Format-detection rule at the fence boundary needs a precedence
  spec.
- DESIGN-0017 sequencing collision: v0.8 ships schema:1-only
  fixtures + SKILL.md authoring section; format changes must
  reconcile with that schedule.
- The agent's 56-block sample (32 TS + 24 Java in two repos) is one
  author's idiom density, not population-representative.
- YAML survives in comparable tools (Jest config, GitHub Actions,
  Ansible, K8s manifests) because YAML in dedicated files is fine;
  YAML inside a foreign carrier is the actual lesson.

This file is preserved as design history. Do not implement.
**Inputs:** real-usage feedback from an agent driving v0.6 blocks in
batch B (Quarkus/Hibernate Java, 24 blocks). After hitting the
YAML colon-trap, apostrophe-quote trap, and the 25-line cap in
real authoring, the agent argued that **YAML is structurally wrong
for in-comment authored context**, not just inconveniently sharp,
and proposed a tag-prefixed format matching Javadoc / JSDoc /
godoc / rustdoc conventions.

> This stub is the design surface for that pivot. DESIGN-0019 §9
> is paused pending the outcome here.

## Problem

DESIGN-0016 (v0.6) shipped `@sivru` blocks as YAML inside a fenced
`@sivru` / `@end` block, carried in the host language's doc-comment.
Real-usage feedback from 56 authored blocks (32 TS, 24 Java) shows
three structural problems that are properties of YAML, not bugs we
can patch:

1. **YAML's syntax fights the host language's syntax.** Java
   JavaDoc carries `key: value`, `tx: REQUIRES_NEW`,
   `@Inject: …`, and apostrophe-wrapped method names
   (`'this.commit()'`) constantly. YAML treats `:` as a mapping
   separator and `'…'` as a single-quoted scalar — every Java idiom
   in invariant prose is a YAML landmine. Authors hit one within
   the first few blocks; the workaround is `"…"`-wrapping every
   value, which is visible noise that breaks readability — the
   whole point of these blocks.

2. **Indent sensitivity is fragile inside comment prefixes.** In
   Java the carrier is `/** … */`; every body line starts with
   ` * `. In TS the same. The JavaDoc parser consumes the leading
   space + asterisk + space; YAML sees what's left. If the author
   forgets one space, YAML's indent shifts silently, the parse
   succeeds, and the resulting structure is wrong without a clear
   error pointing at the cause.

3. **Multi-line strings require YAML ceremony.** A 2-line invariant
   needs `|` (literal) or `>` (folded) with correct indentation.
   Most authors don't know the difference. The YAML list-of-strings
   format adds `- ` to every line and indents nested values — the
   overhead alone eats ~30% of the 25-line block-prose budget. The
   batch-B agent hit `SIVRU-E211 block-prose > 25 lines` twice
   (`SkillToolExecutor`, `SolutionDefinitionEntity`); both times,
   the YAML scaffolding was a meaningful share of the line count.

The structural mismatch matters because sivru is asking authors to
write the contract they are *not* otherwise paid to write. Every bit
of friction is a tax on adoption. YAML's friction is
disproportionately high for the in-comment authoring context.

## Proposal

A tag-prefixed line format inside the same `@sivru` / `@end` fence.
The fence delimiters from DESIGN-0016 stay; everything inside
changes shape.

### Format (proposed)

```
@sivru
@role mmr-diversity-reranker
@does rerank candidates so the top-K mixes relevance with low redundancy
@calls HybridRetriever — single caller; runs AFTER blend, BEFORE CustomerMatchReranker
@calls MemoryEntry — input + output type
@invariant candidates without embeddings are silently dropped; not an error
@invariant MMR overwrites the input score with the MMR-relevance term
@invariant lambda is the rel-vs-diversity dial: 1.0 pure relevance, 0.0 pure diversity
@decision MMR over clustering
@because MMR is one O(K*N) pass with one hyperparameter
@valid-while candidate pool small (<100); cosine is right distance metric
@revisit-if candidate count grows past a few hundred
@maturity stable
@end
```

### Parsing rules (draft)

- **Each tag starts a logical line.** `@<tag> <prose…>` is the
  shape. Prose runs to end-of-line, comment-prefix-stripped.
- **Multi-line continuation by indent.** A line with no `@<tag>`
  whose comment-prefix-stripped content starts with whitespace is
  a continuation of the previous tag's prose. Two-line invariant:
  ```
  @invariant tenant context cleared in finally regardless of throw
    even when the body throws before reaching the cleanup
  ```
- **Grouping rules.**
  - `@role`, `@does`, `@maturity` occur at most once per block.
  - `@calls` and `@invariant` repeat freely; each occurrence is an
    independent entry.
  - `@decision <chose>` starts a new decision; subsequent
    `@because`, `@valid-while`, `@revisit-if` belong to the most
    recent `@decision` until the next `@decision` or end.
  - `@invariant` with a following `@enforced-by` line pairs the
    enforcement reference to that invariant (the DESIGN-0019 §1
    object-form invariants become natural in this format).

### Schema (draft)

| Tag | Required | Repeats | Maps to schema:1 |
|-----|----------|---------|-------------------|
| `@role` | yes | no | `role` |
| `@does` | yes | no | `responsibility` |
| `@calls` | no | yes | `collaborators[]` |
| `@invariant` | no | yes | `invariants[].rule` |
| `@enforced-by` | no | per-invariant | `invariants[].enforced-by` |
| `@decision` | no | yes | `decisions[].chose` |
| `@because` | no | per-decision | `decisions[].because` |
| `@valid-while` | no | per-decision | `decisions[].valid-while` |
| `@revisit-if` | no | per-decision | `decisions[].revisit-if` |
| `@maturity` | no | no | `maturity` |
| `@since` | no | no | reserved (per DESIGN-0019 open question) |

The required pair (`@role` + `@does`) preserves DESIGN-0016 §1's
contract that the minimum valid block is the two-field shape.

### Schema version

Tag format is `schema: 2`. The `schema:` field disappears (no key-
value form remains); detection is by-content: the first non-blank
line after the `@sivru` fence is either a `@<tag>` (schema:2) or a
`schema: 1` / `role: …` YAML key (schema:1).

### Migration story (the load-bearing decision)

Three candidate strategies, all marked open:

**M1 — Both formats parse; new blocks default to tag format.** The
parser detects format on the first body line; both ship at v0.10
through some grace period (v0.10–v0.12 say); a CLI flag
`sivru block migrate path/` rewrites schema:1 YAML blocks to
schema:2 tag format using `blockToJSON()` as the intermediate. After
the grace window, schema:1 is removed.

**M2 — One-shot migration at v0.10.** Ship `sivru block migrate
--all` once; every existing block converts; the parser drops
schema:1 support immediately. Cleaner code, more disruptive.

**M3 — Schema:1 stays read-only forever.** Both formats parse;
schema:2 is recommended for new work; schema:1 is never deprecated.
Lowest disruption, but the codebase carries two parsers indefinitely.

Lean: M1 — three-release grace period balances cleanup against
disruption. To be decided at this design's eng-review.

### Implementation surface

```
packages/search/src/block/
  parse/
    tag.ts            — schema:2 tag-format parser
    yaml.ts           — existing schema:1 parser, kept during grace
    detect.ts         — pick parser by first body line
  types.ts            — SivruBlock unchanged (the JSON shape stays
                         per DESIGN-0016 §5; only the carrier changes)
  toTag.ts            — SivruBlock → tag-format string (for migrate)
  migrate.ts          — orchestrates the YAML→tag rewrite
```

`blockToJSON()` output (DESIGN-0016 §5) is unchanged. The on-disk
form changes; the in-memory canonical shape does not. This keeps
DESIGN-0019's other slots format-agnostic — they consume
`SivruBlock`, not the carrier bytes.

### Errors (new range claimed)

- `SIVRU-E240–E249` reserved for codebase-explainer per DESIGN-0019.
- `SIVRU-E280–E289` reserved here for tag-format diagnostics:
  - `SIVRU-E280 tag-unknown` — `@foobar` is not a known tag.
  - `SIVRU-E281 tag-misplaced` — `@because` without a preceding
    `@decision`; `@enforced-by` without a preceding `@invariant`.
  - `SIVRU-E282 tag-duplicate` — `@role` appears twice in one block.
  - `SIVRU-E283 indent-continuation-ambiguous` — a continuation
    line's indent does not unambiguously bind to the previous tag.
  - `SIVRU-E284 schema-mixed` — both schema:1 YAML and schema:2 tags
    appear inside one fence.

## Alternatives considered

**Stay with YAML; ship DESIGN-0019 §9 autofix (the current
fallback).** Considered at DESIGN-0019 eng-review iter-1. Real, and
the path if this design is rejected. Cost: the structural arguments
above remain real; every future Java/TS author pays the same tax.

**Custom YAML subset that special-cases colon-prose.** Considered
and rejected at DESIGN-0019 eng-review iter-1 D2. Pollutes "block is
just YAML" with carve-outs.

**JSON, TOML, or another off-the-shelf format.** Each carries its
own friction (JSON requires quoting AND brackets, TOML doesn't fit
list-of-objects well, etc.). The point isn't "pick a different
serialization" — it's "match how authors already write structured
prose in comments." Tags match the host's existing convention; no
other off-the-shelf format does.

**Plain prose + LLM extraction.** Reject: the comprehension layer
needs deterministic parsing for diagnostics, drift, and cross-tool
integration. Putting an LLM in the parser breaks the local-first
boundary and turns every `block validate` into a paid API call.

## Open questions

- **Migration strategy.** M1 vs M2 vs M3. Lean M1; pin at eng-review.
- **Continuation-indent rule.** The "indented next line is a
  continuation" rule has edge cases — what if the author indents
  for visual alignment? Spec needs a precise rule before lock.
  Lean: continuation requires strictly more leading whitespace than
  the prefix-stripped `@<tag>` line.
- **Tag-name conventions.** `@does` vs `@responsibility`? `@calls`
  vs `@collaborators`? Short tags read better in dense comments;
  full names match `blockToJSON()` keys directly. Lean: short, with
  a documented mapping table.
- **Whether `@calls Foo — note` (em-dash separator for a note)
  becomes structured (`{ name: "Foo", note: "..." }`) or stays
  flat-string in `collaborators[]`. Today's schema:1 `collaborators`
  is `string[]`; preserving that is least-disruptive.
- **Tooling story.** YAML benefits from existing IDE / format-tool
  support. Tag-format needs at least: tree-sitter grammar awareness
  (so the comment isn't reformatted to break tag alignment) and an
  optional VSCode / IntelliJ syntax-highlight plugin. Scope?

## Acceptance criteria (initial draft)

- Tag-format parser exists; recognizes the tag table above.
- `blockToJSON()` output is byte-identical for equivalent schema:1
  YAML and schema:2 tag blocks (cross-format round-trip).
- Format detection picks the right parser by first body line.
- `sivru block migrate` rewrites every schema:1 block in a path to
  schema:2 tag format; output validates clean; round-trip JSON
  matches input JSON.
- DESIGN-0019's self-dogfood blocks (21 in `packages/search/`,
  21 in `packages/cli/`) migrate cleanly; CI gate passes.
- Block-prose 25-line cap fits more authored content in tag format
  than YAML — measure on the 24-block BuildWright corpus. Target:
  zero `SIVRU-E211 block-prose` warnings on a corpus that hit two
  in YAML.

## Test plan

- Unit: per-tag parsing; continuation-indent edge cases; grouping
  rules (`@decision`/`@because` binding); duplicate-`@role`
  rejection; `@enforced-by`-before-`@invariant` rejection.
- Round-trip: parse schema:1 YAML → JSON → toTag → parse → JSON
  identical. Same the other way for net-new tag-format blocks.
- Integration: `sivru block migrate packages/` rewrites every
  block; full re-validation clean; the BuildWright 24-block corpus
  imports without the YAML workaround quoting.
- Performance: tag parse time on the vitest corpus < the YAML parse
  time (custom parser should be cheaper than js-yaml).
- Block-prose budget: tag format vs YAML, measured line counts on
  the BuildWright corpus's 2 over-budget blocks.

## Customization shape

Per CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — tag table per §Schema above; reserved
   tags; precedence (project beats user beats default).
2. **Declarative override** — `.sivru/block.json` gains
   `format.preferred: 'tag' | 'yaml'` (default `tag` after
   schema:2 lands) and `format.acceptedSchemas: [1, 2]` (default
   `[1, 2]` during grace; tighten to `[2]` after).
3. **Code-level extension** — custom tag handlers via
   `.sivru/block/tags/<tagname>.ts` for project-specific tags
   that map to extra fields in `blockToJSON()`.

## Notes

This is a **Stub**. The next step is `/plan-ceo-review` (this is
a strategic format pivot — CEO-mode review fits before eng-review).
After CEO review, eng-review locks the implementation surface and
migration strategy. Expected interaction with DESIGN-0019:

- If accepted: DESIGN-0019 §9 stays paused; slot-1 acceptance ports
  to whichever format ships at slot-1 ship time.
- If rejected: DESIGN-0019 §9 resumes; slot 1 ships the YAML
  autofix.
- If deferred: DESIGN-0019 §9 stays paused for one more release
  cycle; revisit with more usage data.

Slot mapping (if accepted): DESIGN-0020 likely targets v0.10 or
v0.11. DESIGN-0019's slot 1 either rides v0.10 (if DESIGN-0020
ships at v0.10) or v0.10 with YAML + post-migration adapt.
