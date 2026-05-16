# DESIGN-0016: `@sivru` annotation blocks — authored code context

**Status:** Draft <!-- Draft → Accepted → Implemented → Superseded -->
**Targets:** v0.6.0
**Issue:** filed when v0.6 becomes next release
**Created:** 2026-05-15
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

A `@sivru` annotation block: a small, structured, language-neutral
block of authored context, carried inside whatever doc-comment syntax
the host language already uses, attached to a code symbol.

The block is delimited `@sivru` ... `@end` and contains YAML:

```
@sivru
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

Carrier syntax is the language's native doc comment — `/** */` for
Java and TypeScript, `//` runs for Go, `"""` for Python, `///` for
Rust. The block content is identical across all of them. The only
language-specific code sivru writes is "given a symbol, find its
attached doc comment" — and tree-sitter (v0.2.0, DESIGN-0001) already
provides the parse tree to do that. One small comment-locator per
grammar; everything downstream is shared.

Required fields are `role` and `responsibility`. Everything else —
`collaborators`, `invariants`, `decisions`, `maturity` — is optional,
added only where it earns its place. A block with two fields is valid
and useful; authoring cost scales with value, so the repo accumulates
depth exactly where depth matters.

The `decisions` list is the part that makes a block more than a doc
comment. Each decision is `chose / because / valid-while /
revisit-if` — a claim with a lifetime. An agent reading the block
before an edit sees not just "this is a router" but "single-router
was chosen *because* X, holds *while* Y, revisit *if* Z." It can now
respect the decision, or consciously recognize the revisit condition
is met and override it on purpose. Authored context turns a blind
edit into a judgment.

Sivru's role is the schema, the extractor, and validation — not
authoring. Blocks are written by whoever changes the code: a human,
or far more often a coding agent following `@sivru/skill`
(DESIGN-0003 / DESIGN-0017). On first contact with an un-annotated
load-bearing symbol the agent proposes a block. Sivru parses,
validates, and exposes the parsed structure as `SivruBlock` for the
downstream consumers in DESIGN-0017 and DESIGN-0018.

Public surface — new module `packages/search/src/block/`:

- `SivruBlock` — the parsed type, in `block/types.ts`.
- `extractBlocks(filePath, tree): SivruBlock[]` — given a parsed
  tree-sitter tree, return every `@sivru` block with the symbol it is
  attached to.
- `validateBlock(block): BlockDiagnostic[]` — required-field and
  schema check.

The extractor is pure parse: no network, no LLM, ever. A repo with
zero blocks extracts to `[]` with no error and no cost beyond the
walk that already happens.

## Alternatives considered

**A sidecar manifest** (`.sivru/context.yaml`, one file). Non-
intrusive and language-free. Rejected: it drifts the instant code
moves, and nothing in code review forces it current. The whole point
is context that travels *with* the symbol it describes.

**Native doc-comment conventions only** (Javadoc tags, TSDoc tags,
godoc prose). Rejected: each language's tag vocabulary and tooling
differ, none has anything like `valid-while`, and we would be
maintaining five incompatible schemas. The fenced `@sivru` block
reuses the comment purely as a *carrier* and keeps one schema.

**A new comment syntax or decorator.** Rejected: anything that is not
already a comment breaks compilers, linters, and formatters. The
block must be invisible to every tool except sivru.

**Authoring blocks through a sivru command into sivru's index, never
in source.** Rejected: defeats the purpose. The context would live
outside the repo, invisible in code review and in the editor, and
would not survive a clone.

## Open questions

- Module-level context has no natural symbol. Package level attaches
  to `package-info.java` / `doc.go` / `__init__.py`. Module level —
  repo `README` front-matter, or a `.sivru/module.yaml`? Decide by
  the time v0.6 is cut. (owner: @pochadri)
- A `decision` with no `revisit-if` — allowed (a decision with no
  known expiry) or warned? Lean: allowed. (owner: @pochadri)
- Block size. A block past ~25 lines is probably prose that belongs
  in a design doc. Soft lint warning, or no cap? (owner: @pochadri)

## Acceptance criteria

- `SivruBlock` type defined in `packages/search/src/block/types.ts`.
- `extractBlocks()` pulls `@sivru`/`@end` blocks from doc comments
  across the v0.2.0 tree-sitter grammars; one comment-locator each.
- `validateBlock()` flags missing `role`/`responsibility` and
  malformed YAML; diagnostics carry codes in the `SIVRU-E2xx` range
  (claimed at implementation).
- A block with only `role` + `responsibility` validates clean.
- Extraction is pure: no network, no LLM. A zero-block repo extracts
  to `[]`.
- Round-trip test: an identical block written in 4 carrier syntaxes
  (Java, Go, TypeScript, Python) parses to the same `SivruBlock`.

## Test plan

- Unit: `extractBlocks` against per-language fixture files;
  malformed-block fixtures; a zero-block file.
- Unit: `validateBlock` — missing required field, bad YAML, and the
  valid-minimal case.
- Manual: run extraction on the sivru repo itself once a handful of
  blocks are seeded in `packages/search/`.
- Performance gate: extraction adds < 5% to index time on the vitest
  corpus.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — schema in `packages/search/src/block/
   schema.ts`; required fields `role`, `responsibility`; the set of
   recognized optional fields fixed.
2. **Declarative override** — `~/.config/sivru/block.json` (user) and
   `.sivru/block.json` (per-project, wins): `{ requiredFields,
   optionalFields, maxLines }`. A team can require `decisions` on
   anything under `src/core/`.
3. **Code-level extension** — `.sivru/block/*.ts` register custom
   field validators (for example, "`collaborators` entries must
   resolve to real indexed symbols").
