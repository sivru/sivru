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

## Slice 2 — `--html` UI design (locked in `/plan-design-review`, 2026-06-10)

App-UI posture (calm, dense, utility-first), not a marketing page. Two
audiences: the engineer onboarding to the codebase, and an agent's human
operator reviewing structure. Initial design rating 6/10 → 9/10 after these
decisions.

**Information architecture — locked.** Persistent left sidebar (collapsible
System → Module → Package tree + a search box pinned at top) + main content
pane with a breadcrumb trail. Hash-routed: `#/`, `#/module/<id>`,
`#/package/<id>`, `#/symbol/<id>`. Every route is a real `<a href="#/…">`
(back-button + keyboard work for free). ASCII wireframes per level:

```
SYSTEM (#/)                              MODULE (#/module/packages/cli)
┌──────────┬──────────────────────┐   ┌──────────┬──────────────────────┐
│ ⌕ search │ sivru-monorepo       │   │ ⌕ search │ system › @sivru/cli   │
│ ▾ system │ <narrative prose>    │   │  ▾ cli ◄ │ role·churn 86·5 pkgs │
│  ▸ cli   │ ┌ module dep graph ┐ │   │  commands│ deps→ observe,search │
│  ▸ search│ │ obs-ui ┐         │ │   │  explainer ┌ churn bar ───────┐ │
│  ▸ …     │ │ cli ───┼► search │ │   │  lib     │ │ commands ████ 34 │ │
│          │ └─────────────────┘ │   │          │ │ lib      ███ 29  │ │
│          │ module table·churn  │   │          │ └─────────────────┘ │
└──────────┴──────────────────────┘   └──────────┴──────────────────────┘
PACKAGE (#/package/…/explainer)        SYMBOL (#/symbol/…#buildExplainerModel)
┌──────────┬──────────────────────┐   ┌──────────┬──────────────────────┐
│  ▾explain│ … › cli › explainer  │   │          │ … › explainer › buil…│
│  buildE◄ │ 15 symbols·churn 12  │   │          │ DERIVED exports·imp· │
│  project │ ┌ symbol list ──────┐│   │          │   churn·collaborators│
│  levels  │ │ buildExplainer fn ││   │          │ ┌ @sivru block ────┐ │
│  …       │ │ projectModel   fn ││   │          │ │ role·responsibil.│ │
│          │ └──────────────────┘│   │          │ └──────────────────┘ │
│          │                     │   │          │ ┌ collaborator graph┐ │
└──────────┴──────────────────────┘   └──────────┴──────────────────────┘
```

**System landing hierarchy — locked.** Narrative prose first (answers the
onboarding engineer's "what is this?"), then the module dependency graph as
the visual anchor, then a dense module **table** (name · churn · deps). The
agent-operator still gets the map + table one scroll down.

**The 3 inline-SVG diagrams — locked.** The doc's earlier "request/flow
sequence" is **dropped**: the model is structural (no call-order/runtime
data), so a sequence diagram would be fabricated — it would violate
"projection, not source." The three, all model-derived and hand-rolled (no
library):

1. **Module dependency graph** — deterministic **layered** (Sugiyama-lite)
   or columnar layout, NOT force-directed (force needs iterative simulation
   and is non-deterministic; a regenerated artifact must be reproducible).
   Module counts are small (sivru: 5 nodes / 5 edges). Nodes link to module
   pages.
2. **Churn/size overview** — a sorted horizontal **bar** (not a treemap):
   trivial to hand-roll, calmer, clearer for "which packages change most,"
   and not slop-prone.
3. **Per-symbol collaborator mini-graph** — a deterministic radial/star
   ego-graph (the symbol centred, collaborators around).

**Empty states are features — locked.** Most symbol pages have no `@sivru`
block (~9% annotated), so the un-annotated page is the explainer's biggest
teaching surface. Each empty is a gentle prompt to author, not "N/A":

- Symbol without a block → derived facts render normally, then a quiet
  inline affordance: *"No `@sivru` block yet · add intent"* with the exact
  annotation stub to paste. (The architect-thinking nudge; loops into the
  Slice 3 feedback flow.)
- Stub narrative (no `.sivru/explainer.md` / `ARCHITECTURE.md`) → a one-line
  *"Add a system narrative in `.sivru/explainer.md`"* card on the System page.
- Module/package with no deps → *"No internal dependencies"* (a calm fact).
- Zero search results → *"No symbol/module matches — try a package name."*

**Theme — locked (mirror observe-ui as CSS variables in the inline
`<style>`; no Tailwind in a standalone file):**
`--bg #0f1115 · --panel #161a21 · --border #262b35 · --text #d6d8dd ·
--mute #7a8390 · --accent #d4a056 (amber, used sparingly — one accent) ·
--warn #fbbf24 · --error #f87171`. Prose in a system sans stack; symbols and
code in monospace; an optional webfont may preload with a system-font
fallback (keeps the file offline). One strong anchor per screen; module list
is a dense **table**, never a card mosaic.

**Accessibility & responsive — locked.** WCAG-AA contrast (text on bg ≈13:1,
mute ≈5.2:1, amber-on-bg ≈8:1 — all pass). `focus-visible` outlines on every
interactive element; `/` focuses search; the tree is arrow-key navigable.
Desktop-first; under ~768px the sidebar collapses to a drawer (hamburger),
44px touch targets.

**Code links — locked.** Symbol pages deep-link to source via
`vscode://file/<abspath>:<line>` by default, configurable to a GitHub blob
URL or `none` (see Customization shape).

**NOT in Slice 2 scope (deferred):** the feedback annotate→patch→apply UI
(Slice 3); a search index beyond client-side name fuzzy-match; collapsing/
virtualizing the tree for 10k-symbol repos (revisit if the file gets large —
the load-bearing cap already bounds it).

## Slice 2 — build architecture (locked in `/plan-eng-review`, 2026-06-10)

**Render model — SSR (locked).** The generator (Node/TS) pre-renders every
route's HTML and every SVG at generation time and bakes them into the single
file as hidden sections. The client is a ~30-line vanilla nav shim (a
`hashchange` listener that shows the matching pre-rendered section), authored
as a template-literal string — **no bundler, no browser-side layout code, no
library**. All hard logic lives in normal TS modules (typechecked,
unit-tested, DRY with the Slice-1 model types, deterministic by
construction). This is the proven single-file-report pattern (c8/istanbul,
vitest UI). Rejected: a client-side SPA (pushes layout/escape/render into
untestable vanilla JS or needs a bundler) and a hybrid (pays the SPA
testability cost for the symbol level only).

```
projectModel(repo)              ← Slice 1 (the data)
        │  ExplainerModel
        ▼
renderHtml(model): string       ← Slice 2 entry (html/render.ts)
   ├─ views.ts     node → section HTML (system/module/package/symbol)
   ├─ svg.ts       layeredDag · barLayout · radial   (coords + viewBox)
   │               + renderSvg(coords) → <svg> string  (split for testing)
   ├─ escape.ts    escapeHtml(text) · jsonIsland(model)  (< trick)
   ├─ routes.ts    buildRouteMap(model) · selfVerify(routeMap)
   ├─ search.ts    prebuilt name index + the client filter
   └─ client shim  template-literal vanilla JS string (hashchange → show section)
        │  one <!DOCTYPE html>, JSON island inlined+escaped, zero external assets
        ▼
   selfVerify ASSERTS (fail loud) ──► write ./sivru-explainer.html (--out to override)
```

**Module structure — locked (~7 files under `packages/cli/src/explainer/html/`):**
`render.ts`, `views.ts`, `svg.ts` (the 3 layouts grouped), `escape.ts`,
`routes.ts` (route map + self-verify), `search.ts`, and the client shim as a
string constant. Functional, no classes. Reuses `ExplainerModel` /
`ExplainerNode` from Slice 1 (same package).

**SVG — locked.** Each diagram splits **layout** (pure fn → coordinates +
viewBox) from **render** (coords → SVG string), so geometry is unit-testable
without parsing strings. The module dep graph uses a deterministic layered
(longest-path layering + crossing-reduced ordering) layout, NOT
force-directed. All three are deterministic: same model → identical SVG.

**Escaping / XSS — locked.** `escapeHtml` for all text + attribute content;
the JSON island via `JSON.stringify(model).replace(/</g, "\\u003c")` so a
repo string containing `</script>` (a symbol name, a file path, `@sivru`
block prose) cannot break out of the script tag or inject. Reuse an existing
repo escaper if one exists rather than adding a duplicate.

**Self-verify — locked, runs twice.** (1) At generation time the generator
walks the route map, collects every emitted `#/…` link, and asserts zero
broken internal links / zero not-found views — **fail loud, never write a
broken file**. (2) A vitest test over a fixture model asserts the same and
that a deliberately-broken link is caught.

**Output — locked.** `--html` writes `./sivru-explainer.html` by default
(`.gitignore`d), `--out <path>` to override, and prints the path. Never
stdout (the file is multi-hundred-KB to low-MB).

**Size / perf — locked.** Generation is one-shot. Pre-render-all is bounded
by the load-bearing-symbol cap; the inlined model JSON is ~287 KB / ~36 KB
gzipped on the sivru repo (412 symbols). A generation-time **size warning**
fires if output exceeds a threshold; lazy symbol-detail client rendering is a
deferred optimization, taken only if field data shows oversized files.

**Test plan — locked.** SVG layout (bounds + determinism + degenerate
inputs), views (each empty-state affordance), escaping (the `</script>`
case), route map + self-verify (catches a broken link), search (fuzzy +
zero-results), `renderHtml` (offline: no external `src`/`href`), and a
real-`sivru`-model integration test whose self-verify passes.

## Customization shape

Per the CONTRIBUTING.md three-layer rule:

1. **Built-in defaults** — four-level model; dark neutral theme; the
   default SVG diagram set; `vscode://` code links.
2. **Declarative override** — `.sivru/explainer.json`: theme tokens
   (accent, font), which sections render, drill depth, and code-link
   scheme (`vscode://` | GitHub blob URL | none).
3. **Code-level extension** — `.sivru/explainer/*.ts` register extra
   views or diagram types.
