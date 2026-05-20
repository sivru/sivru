# DESIGN-0019: `sivru explain --project --video` (v0.8 codebase explainer, video mode)

**Status:** Draft <!-- Draft → Accepted → Implemented → Superseded -->
**Class:** Spine (inherits v0.8 — joint with [DESIGN-0018](0018-codebase-explainer.md))
**Targets:** v0.8.0 (joint with DESIGN-0018; ships when video + HTML +
JSON all meet acceptance)
**Issue:** filed when v0.8 becomes next release
**Created:** 2026-05-20
**Author:** @pochadri

> **Reframe note (2026-05-20).** This doc began as a Stub for a
> standalone README marketing video. The `/plan-ceo-review` pass on
> 2026-05-20 reframed the scope: video becomes a third output mode
> of `sivru explain --project` alongside JSON and HTML, sharing the
> v0.8 codebase explainer's projection model (DESIGN-0018). The
> README artifact then becomes a particular *invocation* of that
> mode, not a separately authored thing. The reasoning trail lives
> in `~/.gstack/projects/sivru-sivru/ceo-plans/2026-05-20-explainer-video-as-sivru-capability.md`.

## Problem

Sivru's value is abstract. The README explains "code search +
session observability + comprehension layer" in prose, and reaches
for `WHY-SIVRU.md` to defend the agentic-search-vs-RAG framing in
two more pages. A developer arriving from a link or an HN post
reads several paragraphs to decide whether sivru is for them. We
lose people in that gap.

DESIGN-0018 already plans a whole-repo projection at v0.8 — JSON
for agents, HTML for humans — built from the four-level model
(System → Module → Package → Symbol). What the HTML projection
*cannot* do is the thing motion is uniquely good at: landing the
comprehension thesis in a 60-90s narrative that doesn't require
the reader to drill. And `GOALS.md` names a known risk explicitly:
*"comprehension demos worse than token savings."* A number is
visceral; "your codebase stayed comprehensible" is not. The
explainer is the demo-able artifact; today there is no motion
form of it.

The original framing of this doc (a standalone marketing video)
hit the same problem from the marketing direction: the artifact
goes stale unless someone owns the re-record trigger, and a stale
video actively misleads. Recasting the artifact as a *projection*
of the same source the HTML explainer uses dissolves the staleness
problem structurally — the video updates when the code does,
because the projection runs against the current repo, not a
frozen script.

## Proposal

Add `sivru explain --project --video` as a third output mode of
the v0.8 codebase explainer, parallel to `--json` and `--html`.

### One model, three projections

```
                    Projection model (built once per repo)
                    ─────────────────────────────────────
                    tree-sitter graph + derived facts +
                    @sivru blocks + .sivru/explainer.md
                                  │
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
        sivru explain        sivru explain     sivru explain
        --project --json     --project --html  --project --video
                │                 │                 │
                ▼                 ▼                 ▼
        agent-consumed       human-consumed    human-consumed
        structured data      drill-down HTML   motion (mp4)
```

Every projection is regenerated from the same source. None is
hand-edited. Each is `.gitignore`'d; the repo is the source.

### Three built-in video modes

Per `CONTRIBUTING.md`'s three-layer customization rule, the video
mode is configurable. Three built-in modes ship at v0.8:

- **`system`** (default) — 60-90s whole-repo overview. Title card
  → module dependency graph animates in → top N modules introduce
  themselves with one-line `@sivru` excerpts → request flow → end
  card. Tractable shape for arbitrary repos.
- **`loop`** — 6-12s seamless animated diagram. Doubles as an OG
  share-card / social preview. Skips narration entirely.
- **`drilldown`** — System video + per-module short videos with
  chapter navigation. Higher polish, higher render cost; suitable
  for projects with a small number of load-bearing modules.

The user picks via `.sivru/explainer.json` `video.mode`.

### Scenes are pluggable

Inside each mode is a sequence of *scenes*. A scene is a typed
function over the projection model:

```ts
interface ScenePlugin {
  type: string;                           // matches scenes[].type in .sivru/explainer.json
  render(ctx: {
    model: ProjectionModel;               // same model --json + --html consume
    params: Record<string, unknown>;      // from scenes[].params in the JSON
    theme: ThemeTokens;
    duration: number;                     // seconds, from scenes[].duration
  }): /* Remotion: ReactElement | Motion Canvas: Generator<Frame> */;
}
```

Built-in scene types: `intro`, `outro`, `system-overview`,
`top-modules`, `module-detail`, `request-flow`,
`dependency-graph`, `install-commands`, `code-asciinema-embed`.
Users register additional scenes in `.sivru/explainer/scenes/*.ts`
(see *Customization shape* and *Open questions*).

### Customization shape

Per the three-layer rule:

1. **Built-in defaults.** Default mode is `system` with a default
   scene sequence (intro → system-overview → top-modules →
   request-flow → outro). Dark neutral theme matching observe-ui.
2. **Declarative override** via `.sivru/explainer.json`. New
   `video` section sits alongside the HTML config DESIGN-0018
   already specifies:

   ```json
   {
     "video": {
       "mode": "system",
       "duration": 75,
       "theme": { "accent": "#7c9", "font": "inter" },
       "scenes": [
         { "type": "intro", "title": "what is this repo", "duration": 5 },
         { "type": "system-overview", "duration": 25 },
         { "type": "top-modules", "limit": 5, "duration": 30 },
         { "type": "request-flow", "from": ".sivru/explainer.md", "duration": 10 },
         { "type": "outro", "duration": 5 }
       ],
       "trustPlugins": false
     }
   }
   ```
3. **Code-level extension** via `.sivru/explainer/scenes/*.ts`.
   Disabled by default; `.sivru/explainer.json` must set
   `trustPlugins: true` for them to load (the
   `direnv allow`-style opt-in lean — see *Open questions* for the
   sandboxing question).

### The README artifact

The sivru repo's own README artifact is produced by running
`sivru explain --project --video` in the sivru repo with the
repo's own `.sivru/explainer.json` overrides applied. The
overrides include marketing-tuned scenes (`install-commands`,
`code-asciinema-embed` for the routing-policy moment) so that the
artifact lands the install pitch, not just an architectural
overview. A CI hook on tag pushes the rendered mp4 to the GitHub
release; the README embeds the release asset URL.

The flag naming for the canonical-README-target signal
(`--self`, `--canonical`, or none) is an open question — see
below.

### The pre-v0.8 README bridge

The README needs *something* before v0.8 lands (5 releases out).
Out of scope for this doc, but the agreed plan: a static SVG
diagram of the routing-policy two-channel framing from
`WHY-SIVRU.md`, embedded near the top of `README.md` with a
one-line caption pointing at v0.8's `sivru explain --project
--video` as the full demo. Ships in the next docs PR on main.
When v0.8 lands, the SVG is replaced by the rendered video link
as part of v0.8's PR.

## Alternatives considered

- **Standalone hand-recorded marketing video** — the original
  Stub's framing. Rejected because (a) keep-current requires a
  named human owner per re-record cadence (the four commitments
  the Stub itself listed as disqualifying without an owner), and
  (b) a marketing artifact next to the codebase-explainer that
  shares its content but not its substrate would inevitably
  diverge.
- **Live asciinema cast only** — minimal viable. Records the demo
  moment, near-zero upkeep. Rejected at D1 of the CEO review
  because it misses the comprehension-thesis pitch in motion,
  which prose has consistently failed to land.
- **Defer entirely; v0.8 HTML explainer IS the demo** — GOALS.md
  names the explainer as the demo-able artifact. A reasonable
  reading is "HTML embedded as a link is enough." Recorded as
  Reviewer Concern #5 below; the chosen direction is to extend
  rather than defer, with the bridge SVG as the pre-v0.8 answer.
- **Per-symbol drill-down videos** — multiplies the keep-current
  surface to N short videos per repo. Out of scope for v0.8;
  reachable later via the `drilldown` mode if user appetite
  emerges.
- **External motion-graphics tools (After Effects, Final Cut)** —
  not regenerable from repo source; rejected on the same grounds
  as hand-edited video.

## Open questions

- **Tool choice (Remotion vs Motion Canvas).** Remotion is React-
  native and matches the stack, but has a paid company-license
  threshold that must be confirmed before any work starts. Motion
  Canvas is MIT but has a smaller community and a different
  mental model (generator functions, not React components). The
  choice meaningfully shapes the `.sivru/explainer/scenes/*.ts`
  contract above. Spike output: decision note appended to this
  doc.
- **`@sivru/explainer-video` packaging strategy.** Whether video
  rendering ships in `@sivru/cli` (heavy install — Remotion
  bundles ~150-300MB including Chromium) or as a separately
  installed `@sivru/explainer-video` package the CLI shells out
  to. **Gating rule:** tool-choice spike returns the install
  footprint; if > 50MB, ship as a separate package with a
  first-invocation `sivru explain video-deps install` hint.
- **Story selector for `system` mode on arbitrary repos.** The
  default-mode algorithm picks the top-N modules (by public-API
  surface + churn + presence of `@sivru` blocks) and assigns a
  duration budget per module proportional to load-bearing-ness.
  The *spec* is part of v0.8 (the Draft writes it); the *spike*
  produces the weighting inputs by running on 2-3 non-sivru
  repos. Without this, `system` works for sivru and degrades
  silently on arbitrary repos — the largest single feasibility
  risk in this design.
- **Scene-plugin sandboxing.** Lean: `trustPlugins: true` opt-in,
  same model as `direnv allow`. Open question is whether
  stricter mitigation (VM module sandbox, or shipping plugin
  loading as a separate flag entirely) is warranted given this
  is the first sivru feature pushing opt-in code execution into
  the CLI surface. See Reviewer Concern #7 below.
- **Canonical README artifact flag.** `--self`, `--canonical`,
  `--readme-target`, or none of the above (just document that
  the README artifact is the default-command output in the sivru
  repo). The flag does not change config loading — it's a CI /
  release-target signal only.
- **`.sivru/explainer.md` schema lock for both HTML and video.**
  Video scenes consume the narrative source DESIGN-0018 defines
  for HTML. If video's timing/scene-anchor needs push richer
  structure back into the narrative format, DESIGN-0018's scope
  inflates. Lock the schema for both surfaces before either
  ships.

## Acceptance criteria

The feature is done when:

- `sivru explain --project --video` emits an mp4 from the same
  four-level model `--json` and `--html` consume.
- Three built-in modes ship: `system` (default, 60-90s overview),
  `loop` (6-12s seamless), `drilldown` (chaptered per-module).
- `system` mode includes a configurable intro/outro scene slot
  (default-empty; sivru's own `.sivru/explainer.json` populates
  it with the routing-policy diagram + install-command beat that
  the README actually needs).
- Story selector for `system` mode is implemented: deterministic
  algorithm picks top-N modules and assigns per-module duration
  proportional to load-bearing-ness. Works defensibly on at least
  two non-sivru repos chosen during the spike.
- Three-layer customization parallels `--html`: defaults →
  `.sivru/explainer.json` `video` section →
  `.sivru/explainer/scenes/*.ts`.
- Scene plugin loading is opt-in via `trustPlugins: true`;
  disabled by default.
- mp4 renders as GitHub-embeddable (h.264 baseline, reasonable
  bitrate). README's animated artifact is committed to a GitHub
  release and embedded via the release-asset URL.
- Re-render against the same repo state produces an identical
  PNG frame sequence given pinned Chromium + pinned fonts. CI
  re-render diff is a perceptual hash (SSIM threshold), not a
  byte diff. mp4 byte-equality across platforms is explicitly
  *not* a goal (libx264 + Chromium rasterization variance makes
  it unachievable cross-platform).
- Audio is out of scope for v0.8 unless surfaced by the spike.
- Post-build self-verify: render walks zero broken scene
  references and zero missing model nodes, parallel to
  DESIGN-0018's HTML route walk.
- Performance gate: `sivru explain --project --video` on the
  sivru repo completes in ≤ 5 minutes on CI-class hardware
  (M1 Mac or equivalent x86_64). Arbitrary-repo render time is
  measured but not gated for v0.8.
- The pre-v0.8 README bridge SVG (separate PR) is superseded by
  the rendered video link in v0.8's PR.

## Test plan

- **Unit:** scene-plugin contract (model → frame output);
  story-selector algorithm against fixture repos with known
  module structure; theme-token application.
- **Integration:** render against sivru's own repo end-to-end;
  embedded self-verify route walk passes with zero broken scene
  references.
- **Determinism:** render twice on the same pinned environment;
  PNG frame sequences match. Render across platforms (macOS +
  Linux); SSIM threshold met per scene.
- **Manual:** generated mp4 embeds on github.com README,
  GitHub release page; renders correctly on a Twitter / HN
  share preview.
- **Performance:** `time sivru explain --project --video` on
  sivru's own repo on the perf-gate fixture machine; ≤ 5 minutes.
- **First-watch check (qualitative):** a developer who has never
  seen sivru watches the rendered video without prior context
  and can articulate (a) what sivru does, (b) when they'd reach
  for it vs grep, (c) the install command. n=3 minimum, before
  the v0.8 release.

## Reviewer Concerns

Surfaced by the `/plan-ceo-review` outside-voice pass on
2026-05-20 (Claude subagent; codex 400 on gpt-5-codex on a
ChatGPT account). Verdict: *"Reframe has critical gaps."* The
user chose to keep the plan and record the concerns here for
this Draft to address (option B at D10). These are NOT acted on
in this Draft — they are open questions the Accepted version
must answer.

1. **Dogfood circularity.** The "product demonstrates itself by
   producing itself" claim is partially circular: the sivru
   README artifact lands the pitch because the sivru repo's own
   `.sivru/explainer.json` + custom scene plugins are hand-tuned
   for marketing intent. The architectural elegance ("one model,
   three projections") is doing none of the load-bearing work
   for the README specifically; the hand-tuned config is. Open:
   is the dogfood claim load-bearing for general repos, or just
   for sivru?
2. **Keep-current problem relocated, not dissolved.** The four
   keep-current commitments from the original Stub (trigger,
   owner, source, date stamp) now apply to
   `.sivru/explainer.json` + custom scenes. The video updates
   structurally when code does, but the *pitch beats* live in
   hand-authored config that drifts. Open: how does this differ
   in practice from the original Stub's risk?
3. **Story-selector fallback collapses to original Stub.** If
   the story-selector spike fails, the proposed v0.8.5 fallback
   ("ship `--video --self` only") IS the original "hand-animated
   marketing artifact" with extra packaging. Open: what
   specifically distinguishes the fallback from the original
   Stub, and is it a meaningful win?
4. **ROADMAP principle 3 violation.** v0.8 now bundles six
   interlocking pieces (HTML + JSON + video renderer + scene
   plugin system + story selector + perceptual-hash CI gate) in
   one release. Principle 3 explicitly says *"we don't queue
   five features deep and hope."* Open: is v0.8 actually
   splittable into v0.8 (HTML + JSON) and v0.8.5 (video), and
   what's the minimum-viable v0.8 that ships a defensible
   explainer?
5. **GOALS.md tension.** GOALS.md says *"the explainer is the
   demo-able artifact; lean on it."* A reading of that line is
   "HTML embedded in the README is the demo," not "we also
   render a video of it." Open: does the video extension
   faithfully extend GOALS.md's stated demo artifact, or does it
   inadvertently dilute the "HTML is the demo" framing the rest
   of the project relies on?
6. **Bridge SVG may suffice.** A 2-4h static SVG (the pre-v0.8
   bridge, separate PR) may close the README conversion gap
   entirely. Open: what observable signal would tell us the SVG
   was sufficient and the v0.8 video should be cut to keep v0.9
   on the spine?
7. **Scene-plugin trust surface.** First sivru feature pushing
   opt-in code execution (Node + Chromium) via the CLI surface.
   `trustPlugins: true` is the named lean, but `direnv allow`
   invokes shell, not browser code with network access. The
   privacy boundary in `CLAUDE.md` is the product. Open: does
   scene-plugin opt-in fit inside the privacy boundary, or does
   it require its own positioning?
8. **Unvalidated premise.** *"We lose people in the README gap"*
   was asserted from the original Stub, not measured. README
   readers may skim diagram + 3 install commands and never
   unmute a 90s autoplay video. Open: what evidence would
   validate or invalidate the video premise pre-implementation?
9. **`.sivru/explainer.md` schema bleed.** Video scenes
   reference DESIGN-0018's narrative source. If video timing /
   scene anchors push richer-than-HTML-needs structure back into
   the narrative format, DESIGN-0018's scope inflates. Open: is
   the narrative schema locked for both HTML and video before
   either ships, or does video drive it?

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | 6 proposals, 6 accepted (all absorbed by reframe), 0 critical gaps; mode EXPANSION |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE VOICE:** Claude subagent (codex 400 on gpt-5-codex; ChatGPT-account
  fallback per prior learning). Verdict: "Reframe has critical gaps." Returned 9 substantive concerns
  recorded as "Reviewer Concerns" above for the Accepted version to address.
- **CROSS-MODEL:** Inside review and outside voice agree on the architectural
  elegance of the reframe (one model, three projections). They disagree on
  whether the dogfood claim is load-bearing and whether v0.8 should bundle six
  interlocking pieces. User chose to keep the reframe and record concerns
  rather than rolling back.
- **UNRESOLVED:** 0 unresolved decisions (D1-D11 all answered). 9 Reviewer
  Concerns are open for the Accepted version.
- **VERDICT:** CEO REVIEW CLEARED — eng review required before ship.
  Recommended next: `/plan-eng-review` to lock the v0.8 architecture before
  the spike work begins; `/plan-design-review` on the bridge-SVG PR when it
  opens.
