# DESIGN-0019: README explainer video

**Status:** Stub <!-- Draft → Accepted → Implemented → Superseded -->
**Class:** Proof (per [GOALS.md](../../GOALS.md))
**Targets:** ongoing docs / marketing artifact — *not* a sivru version
slot (no npm release). Keeps the demonstration current as the product
evolves.
**Issue:** filed when work starts
**Created:** 2026-05-20
**Author:** @pochadri

## Problem

Sivru's value is abstract. The README explains "code search +
session observability + routing-policy skill" in prose, but the actual
*demo-able moment* — an agent that would have grepped seven times now
asks `sivru.search` once and finds the right symbol — never lands by
reading. GOALS.md flags this explicitly: *"comprehension demos worse
than token savings"*; *"the explainer is the demo-able artifact; lean
on it."*

A short video on the README closes that gap. It also serves the
"different from comparable projects" question — the agentic-search
vs hybrid-retrieval framing in `WHY-SIVRU.md` is much easier to land
in 60 seconds of motion than in two pages of prose. And it carries
the "how to use it" surface (install, MCP add, skill install) in a
single watchable artifact.

Today, a developer arriving from a link or an HN post reads three to
six paragraphs to decide whether sivru is for them. We lose people in
that gap.

## Proposal

A short README-embedded video that answers, in order: (1) what sivru
is, in one sentence backed by one visual; (2) how it differs from
generic agentic search; (3) how to use it (the three install
commands); (4) where to go next.

Target length: 60–120 seconds. Two reasonable shapes — pick one in
Draft:

- **Concept explainer** — animated diagram of the comprehension
  problem and the two-channel routing policy. Lower-level rendering
  (Remotion or similar React-based code → mp4). On-brand for
  "everything is code." Higher polish, higher build + license cost.
- **Live usage cast** — real terminal recording (asciinema) showing
  `sivru search`, `sivru skill install`, `claude` routing to
  `sivru.search` on a behavioural query, side-by-side with the
  grep-only baseline. Tiny, authentic, near-zero upkeep, embeds as
  GIF/SVG directly in the README. Misses the "what is the
  comprehension layer" pitch.

The Draft phase picks one (or a hybrid — usage cast first, concept
explainer later if the usage cast proves the appetite). It must also
settle the embedding mechanism (GitHub-rendered uploaded mp4 vs
thumbnail-linked YouTube/Loom) and the keep-current pipeline.

### What "kept current" actually means

The reason to design this rather than impulse-build it: a *stale*
video actively misleads. The PR that this doc lives next to
(PR #21, the v0.4 skill) was itself a working example of doc drift —
ARCHITECTURE.md fell behind the code by two days. The video has to
have:

- a documented re-record / re-render trigger (e.g. "any change to the
  install commands, any change to the `SKILL.md` headline framing,
  any change to the comparison framing in `WHY-SIVRU.md`");
- an owner for that trigger;
- source-of-truth source files in the repo (Remotion code or asciinema
  cast files) so the artifact can be regenerated, not just edited;
- a date or version tag on the embedded artifact so a stale embed is
  visible to readers.

If we can't commit to those four, we don't ship the video — we ship a
single static screenshot instead.

## Alternatives considered

- **Static screenshot + alt text** — zero cost, zero upkeep, lands
  none of the "see it move" punch. Acceptable fallback if the
  keep-current commitments above can't be made.
- **Multiple short videos** — one for the concept, one for usage, one
  for each major feature. Higher coverage; multiplies the
  keep-current burden. Defer until at least one video proves it can
  be maintained.
- **No video; lean on the v0.8 codebase explainer
  (DESIGN-0018) as the demo-able artifact** — GOALS.md names the
  explainer as the demo. Internally consistent, but the codebase
  explainer is interactive HTML, not a 60-second pitch. The two
  artifacts answer different questions and aren't substitutes.
- **Remotion vs lighter motion-graphics tools** — Remotion is
  React-native, fits the stack, but has a **paid company-license
  threshold** that needs checking before committing. Alternatives:
  Motion Canvas (also code, MIT), After Effects / Final Cut (not
  code, doesn't fit "regenerable from repo source"), or hand-edited
  in any video editor (worst for keep-current).

## Open questions

- **Tool choice.** Resolve in Draft. The decision turns on:
  Remotion's company-license terms vs Motion Canvas / asciinema /
  static. Whoever drafts this confirms the license question first;
  it's not negotiable once a company is involved.
- **Hosting + embedding.** GitHub renders uploaded mp4s; YouTube
  needs a thumbnail link; npmjs renders neither. Pick one primary,
  document the limitation.
- **Owner of the keep-current trigger.** Without a named owner this
  doc should not move past Stub — that's the difference between a
  living artifact and the next thing to drift.
- **Length and structure.** 60s vs 120s; one video vs two.

## Acceptance criteria

The feature is done when:

- A video (or chosen alternative) is embedded in `README.md` and
  renders correctly on github.com.
- The source artifact (Remotion project, asciinema cast, or
  equivalent) lives in the repo and regenerates the embedded file
  via a documented command.
- The keep-current trigger and owner are written into
  `CONTRIBUTING.md` (or a `docs/explainer-video.md` companion).
- A date or version tag is visible on the embedded artifact so
  staleness is obvious to readers.
- The video carries: what sivru is, how it differs from generic
  agentic search, the three install commands, the "see it route"
  moment, and the next-step link.

## Test plan

This is a docs/marketing artifact; the test is qualitative.

- **First-watch check:** a developer who has never seen sivru
  watches the video without prior context and can articulate (a)
  what sivru does, (b) when they'd reach for it vs grep, (c) the
  install command. n=3 minimum, before merge.
- **Currency check:** after any change to the install commands or
  the routing-policy framing, the video is re-rendered or a TODO is
  filed to do so before the next release.
- **Embed render check:** the embed renders on github.com and
  degrades gracefully on npmjs.com (static thumbnail at minimum).

## Customization shape

N/A — this is a single artifact, not a feature with a registry. No
three-layer customization to spell out.
