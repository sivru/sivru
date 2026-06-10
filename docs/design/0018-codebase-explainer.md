# DESIGN-0018: Codebase explainer — the interactive projection

**Status:** Accepted (promoted from Draft on 2026-06-10 by
`/plan-eng-review` iter-1 PASS; sliced into 3 shippable releases — Slice 1
in flight) <!-- Draft → Accepted → Implemented → Superseded -->
**Targets:** Slice 1 → v0.11.0 (planned v0.8.0; the slot moved as the
v0.8–v0.10 sequence diverged — see ROADMAP "shipped sequence" note)
**Issue:** filed when v0.8 becomes next release
**Created:** 2026-05-15
**Author:** @pochadri

> **Implementation note (2026-06-10) — locked in eng review.** The feature
> ships in **three slices**, each a release; the HTML *projection* is a
> standalone self-contained file, never an observe-ui tab.
>
> - **Slice 1 (this release) — model + `--project` JSON, UI-free.** The
>   agent-consumable foundation. Everything downstream projects from it.
> - **Slice 2 — `--html`** read-only projection (hash routing, 3+
>   inline-SVG diagrams, client-side search, self-verify route walk).
>   Run `/plan-design-review` on it (real visual surface).
> - **Slice 3 — feedback loop** (annotate → export patch → apply to
>   `@sivru` blocks / `.sivru/explainer.md`).
>
> **Model shape (the contract slices 2/3 consume) — locked.** One generic
> recursive node, typed by level, NOT four rigid per-level interfaces:
>
> ```
> ExplainerNode {
>   id: string                 // stable, route-able (e.g. "module:packages/cli")
>   level: "system" | "module" | "package" | "symbol"
>   name: string
>   path: string               // repo-relative POSIX
>   children: ExplainerNode[]
>   derived: {
>     exports: string[]              // public API names (symbol level)
>     importsResolved: string[]      // repo-relative targets
>     churn: number                  // commitCount from the index
>     depEdges: string[]             // module/package level: ids it depends on
>     collaborators: string[]        // symbol level: block.collaborators ∪ import callees
>   }
>   block: SivruBlockJSON | null     // the fused @sivru block
>   narrative?: string               // system level only
> }
> ```
>
> Slice 1 emits the **full** structural data (`depEdges`, `collaborators`)
> even though it renders nothing — so the contract is locked once and
> slices 2/3 are pure consumers (no schema re-litigation).
>
> **Build strategy — locked.** Build from **one** `loadOrBuildSymbolIndex`
> pass + `buildCommitCounts` (already one batched git call) +
> `extractBlocks` (prefer the index's opt-in block cache, fall back to a
> parse). **No per-file `assembleArtifact` loop** — that would be ~2,000
> per-file git calls on a large repo and blow the <10s gate. The index
> entry already carries `exports`, resolved `imports`, and `commitCount`;
> module dep-edges derive from the resolved imports. Per-file deep facts
> (callers, ownership, tests) stay reachable via the existing
> `explain <file>` drill-down, not duplicated into the project model.
>
> **Directory → level mapping — locked.** Monorepo: `module` = workspace
> package dir, `package` = top-level `src/` subdir; single-package repo:
> collapse `module`/`package`. The one ambiguous rule; it gets its own
> unit test on both repo shapes.
>
> **Open questions — resolved.** (1) Narrative source: read
> `ARCHITECTURE.md`/`README` if present → `.sivru/explainer.md` → stub.
> (2) Symbol cap: load-bearing only (has a `@sivru` block OR a public
> export) — falls out of building from the index. (3) Caching:
> `computeStateId`-keyed model cache, reusing the explain cache mechanism.

## Problem

`sivru explain <path>` (v0.5.0) answers "tell me about this file."
But nobody onboarding to a codebase starts at a file. They start at
"what is this system, what are its parts, how do they fit together"
— and drill down from there. Sivru has no artifact for that.

What teams build instead is a hand-written `ARCHITECTURE.md` and a
diagram. Both lie within a month, because both are copies of the
truth rather than projections of it. When the code changes, nothing
forces the doc to follow. The reader cannot tell which parts are
current. The agent cannot trust it as context.

By v0.7.0 sivru holds everything needed to do this properly: a
tree-sitter symbol graph, derived facts per file (`explain`), and
authored `@sivru` blocks (DESIGN-0016/0017). The missing piece is a
whole-repo projection that fuses them into something a human can
navigate and an agent can consume — and that is regenerated, never
maintained by hand, so it cannot rot.

## Proposal

`sivru explain --project [--html]` — a whole-repo projection.

It walks the repo, builds a four-level model — System → Module →
Package → Symbol — and fuses the two data sources sivru already
produces: derived facts (`explain` per file: public API, call graph,
churn) and authored context (`@sivru` blocks). Without `--html` it
emits the model as structured JSON for an agent or another tool.
With `--html` it emits a single self-contained HTML file: hash-routed
drill-down across the four levels, inline-SVG diagrams (module
dependency graph, request/flow sequence, per-symbol collaboration
mini-graph), client-side search, no external assets, works offline.

The HTML is a **projection, not a source**. It is regenerated, never
hand-edited, and should be `.gitignore`d. Every description in it
traces back to a `@sivru` block or a repo doc — so regenerating it
after the code changes is lossless. This is the property a
hand-written `ARCHITECTURE.md` can never have.

**Feedback closes the loop.** The HTML ships a feedback mode: a
reader annotates any section in place, and export produces a
structured patch. Applying that patch does not touch the HTML — it
edits the `@sivru` block in the source symbol the section was
projected from. The correction lands where the truth lives; the next
`sivru explain --project` reflects it permanently and everywhere.
Feedback with no symbol home — the system narrative, concepts, the
request lifecycle — is written to `.sivru/explainer.md`, a
repo-tracked narrative source the projection reads on every run.

So the loop is: code (+ `@sivru` blocks + `.sivru/explainer.md`) →
`sivru explain --project` projects → HTML → reader feedback → patch
applied to blocks / narrative → regenerate. The artifact is always
downstream; the repo is always the source.

**The Claude-side skill collapses into sivru.** Any standalone
"generate an explainer" skill would re-implement the code parsing
sivru already does, and its output would drift from `sivru explain`.
Instead `@sivru/skill` (DESIGN-0003) documents the flow: "to build
or refresh a codebase explainer, run `sivru explain --project
--html`; to apply reader feedback, edit the `@sivru` block the
feedback points at." No separate skill, no scanning logic outside
sivru.

Public surface — extends `packages/cli/src/commands/explain.ts`
(`--project`, `--html`); HTML generator in
`packages/cli/src/explainer/` (model builder, page template, SVG
builders); narrative source `.sivru/explainer.md`.

## Alternatives considered

**A new tab in observe-ui.** Rejected: observe-ui needs the Hono
server running. The explainer must work as a standalone file you can
open, email, or commit to a wiki. Different artifact, different
lifecycle. The Phase-7 map view stays in observe-ui — it is session
heat plus churn, a genuinely different thing.

**Keep it as a standalone Claude skill.** Rejected: the skill would
re-implement code parsing sivru already owns, and its output would
diverge from `sivru explain`. The projection must consume sivru's
one model.

**Mermaid or another external JS library for diagrams.** Rejected:
breaks offline and adds hundreds of KB. Diagrams are inline SVG
generated from the model.

**Per-page HTML files instead of one routed file.** Rejected: a
single self-contained file is portable and serverless; hash routing
gives full drill-down without any of the cost.

## Open questions

- The system narrative — fully authored in `.sivru/explainer.md`, or
  partly inferred from existing repo docs (`ARCHITECTURE.md`,
  `docs/`)? Lean: read existing docs if present, fall back to
  `.sivru/explainer.md`, generate a stub if neither exists. (owner:
  @pochadri)
- HTML size on a large repo. Symbol pages should be capped to
  load-bearing symbols — those with a `@sivru` block or public API —
  not every function. Confirm the cap. (owner: @pochadri)
- Does `--project` cache its model, or recompute each run? Lean:
  cache keyed on repo state, like the `explain` call-graph cache.
  (owner: @pochadri)

## Acceptance criteria

- `sivru explain --project` emits the four-level model as JSON.
- `--html` emits one self-contained file: hash routes for
  system / module / package / symbol; no external assets except an
  optional webfont with a system-font fallback.
- Every symbol page fuses derived facts with that symbol's `@sivru`
  block.
- At least three inline-SVG diagram types; module-diagram nodes link
  to module pages.
- Feedback mode: annotate in place, export a structured patch; the
  patch targets `@sivru` blocks or `.sivru/explainer.md`, never the
  HTML.
- Regeneration after a code change loses no authored content.
- Post-build self-verify: the generator walks every route and
  asserts zero broken internal links and zero not-found views.
- `@sivru/skill` documents the generate and feedback-apply flow.

## Test plan

- Unit: model builder (structure from a fixture repo); SVG builders
  (diagram geometry stays in viewBox bounds); the route table.
- Integration: generate against the sivru repo itself; the embedded
  self-verify route walk passes with zero broken links.
- Manual: feedback round-trip — annotate a section, export the
  patch, apply it, confirm the `@sivru` block in source changed and
  a regenerate reflects it.
- Performance gate: generation completes in under 10 s on a
  2,000-file repo.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — four-level model; dark neutral theme; the
   default SVG diagram set; `vscode://` code links.
2. **Declarative override** — `.sivru/explainer.json`: theme tokens
   (accent, font), which sections render, drill depth, and code-link
   scheme (`vscode://` | GitHub blob URL | none).
3. **Code-level extension** — `.sivru/explainer/*.ts` register extra
   views or diagram types.
