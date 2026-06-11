# DESIGN-0022: Explainer — from projection to reasoning surface

**Status:** Draft <!-- Draft → Accepted → Implemented → Superseded -->
**Targets:** after DESIGN-0018 Slice 3 (sequences over several releases)
**Issue:** filed when the first move is scheduled
**Created:** 2026-06-11
**Author:** @pochadri

> **CEO review (2026-06-11) — scope sharpened, not expanded.** Three cuts:
> (1) **Finish DESIGN-0018 Slice 3 (feedback loop) first** — it is the
> write-back mechanism the whole "keep intent current" vision runs on.
> (2) The differentiated 10x is **drift + hot spots + the PR gate**, not a
> metrics dashboard — Martin's instability/abstractness/main-sequence metrics
> are deferred (engineers glance once and ignore them; prove demand first).
> (3) **M-D becomes a deterministic *authored-story*** (assemble the authored
> `@sivru` intent into a readable system narrative — projection, not
> generation); the LLM-generated version is deferred to research, because an
> LLM narrative spends the scarce innovation token on the least-differentiated
> capability and imports the "confidently wrong" failure mode sivru exists to
> oppose. See the Sequencing and Deferred sections for the revised plan.

## Problem

DESIGN-0018 gives the explainer (`sivru explain --project [--html]`) a
four-level model and a self-contained projection of it. That answers
**"what are the parts and how do they connect"** — structure. It is table
stakes: `tree` plus a graph library covers most of it, and a static
dependency map is opened once at onboarding and never again.

The goal (`GOALS.md`) asks for more than a map. It asks sivru to keep a
codebase *comprehensible* — to serve *why the code is the way it is* "to the
next agent or human at the moment it matters — the edit." Measured against
that, today's explainer has four gaps:

- **No meaning.** It shows shape, not what the system *does*. An engineer
  onboarding wants "how does a query flow end to end," not a churn bar.
- **No judgment.** It reports facts (deps, churn, exports) but never says
  *where to look* — which coupling is dangerous, which symbol is a god
  object, where complexity is accreting.
- **No drift.** It is a snapshot. It cannot tell you the code has diverged
  from its authored intent — the exact failure the goal exists to prevent.
- **Not at the edit.** It is a human artifact consumed once, not woven into
  the PR, the CI gate, or the agent's working context.

Closing these turns the explainer from a projection you *look at* into a
**reasoning surface** humans and agents *act through*.

## Proposal

Four capabilities, each built on the Slice-1 `ExplainerModel` (the locked
contract). Deterministic-first; the one networked capability is last and
fenced by a hard grounding discipline.

```
                 ExplainerModel  (DESIGN-0018, shipped)
                        │
   ┌──────────┬─────────┼─────────────┬───────────────┐
   ▼          ▼         ▼              ▼               ▼
 M-A        M-B        M-C            M-D          (humans + agents
 health     diff       agent map     narratives     both consume)
 (det.)     (det.)     (det., MCP)    (LLM, opt-in)
```

### M-A · Architectural judgment (the health/smell layer)

Compute signal on the model and **rank where to look**, instead of listing
facts. **Committed core (the two signals that change behavior):**

- **Hot spots** — `churn × coupling`: where bugs will come from.
- **Drift** — symbols whose `@sivru` invariants no longer match the code
  (this *is* the coach loop, DESIGN-0005/0006/0007, surfaced on the map).

Plus **dependency cycles** (cheap, and the layered map can't draw them
cleanly today). The academic metrics — Martin instability (I) / abstractness
(A) / main-sequence distance, god-object outlier scoring — are **deferred**
(see Deferred): they read rigorous but engineers glance once and ignore them;
prove demand before building the dashboard.

Pure computation over the model — no network, deterministic, on-thesis: the
most direct embodiment of "make every engineer think like an architect."
Renders as a ranked "Attention" panel and badges on module/symbol pages.

### M-B · The diff view (architecture of a change)

`sivru explain --project --diff` → the **architectural delta** of a PR: new
dependency edges, a cycle that did not exist before, an `@sivru` invariant a
change violates, the shape change. Reuses the existing `explain --diff`
machinery. Lives in PR review and CI (`--gate` fails the build on a
violated authored invariant or a new cycle). The static explainer is opened
at onboarding; the **diff** explainer is opened on every PR — this is the
move that makes it a daily habit, not a quarterly artifact.

### M-C · The agent's working map (the platform layer, MCP)

Stop treating the model as a thing only humans read. Expose it as the
**context substrate an agent routes through**: an MCP tool that, given a task
or a target symbol, returns the relevant model slice — the involved
modules/symbols, their authored intent, their collaborators, their health
flags — so the agent grounds on the architecture instead of re-grepping
every turn. This is the "host more agent-helping tools" half of the
long-term goal: the explainer makes *every other* coding agent smarter on
this repo. Builds on M-A (the health flags are part of the context).

### M-D · Authored-story (the meaning layer, deterministic)

Assemble the prose the explainer cannot *derive structurally* — but **from
authored content, not generation**: stitch the `@sivru` block
responsibilities/decisions + public signatures + the import-derived flow into
a readable "what this is and how it fits" system story. Templated,
deterministic, no network, no hallucination — it is a **projection** of the
authored intent, exactly like the rest of the explainer. Where intent is
missing, it shows the same "add `@sivru`" affordance Slice 2 already has,
turning gaps into authoring prompts rather than guesses.

This gets the bulk of the human-onboarding value ("what does this do") while
staying fully on-brand: sivru never invents an explanation it can't trace to
something a human wrote. The **LLM-generated** version of this — prose the
authored content doesn't cover — is deferred to research (see Deferred).

## Sequencing (revised in CEO review)

**Prerequisite: finish DESIGN-0018 Slice 3 (the feedback loop).** Drift
detection is only half a loop without a way to act on it, and the
authored-story is richer when authoring is frictionless. Close the started
loop before opening this front.

Then, deterministic-only — the LLM is out of the committed plan:

| Order | Move | Risk | Why here |
|------:|------|------|----------|
| 0 | **DESIGN-0018 Slice 3** | low | The write-back loop everything else leans on; already started |
| 1 | **Drift + hot spots + gate** (M-A core ∪ M-B) | low (no net) | The differentiated 10x: "where did the code diverge from intent, and block the PR that breaks an invariant." Daily habit, reuses the coach loop + `explain --diff`. Nobody else gates on authored-intent drift. |
| 2 | **Agent map (MCP)** (M-C) | low (no net) | Platform moat; serves the drift/health slice to any agent |
| 3 | **Authored-story** (M-D, deterministic) | low (no net) | Assemble authored `@sivru` intent into a readable system narrative — projection, not generation |

Each move is its own design doc + release once scheduled; this doc is the
spine. The original "M-A full metric suite" and "M-D LLM narratives" are
**deferred** (below), not in the committed plan.

## Deferred (CEO review 2026-06-11)

Not in the committed plan; revisit on evidence.

- **The academic metric suite** (Martin instability/abstractness/main-sequence
  distance, god-object outlier scoring). Looks rigorous; unproven that it
  changes behavior. Ship the hot-spots + drift core first; add these only if
  users ask.
- **LLM-generated narratives** (the original M-D). Highest brand risk and
  lowest differentiation — it spends the scarce innovation token on a
  capability every tool has and imports the "confidently wrong" failure mode
  sivru exists to oppose. Stays research-status behind the grounding gate
  below until the deterministic authored-story proves the demand and the
  grounding verifier is airtight.

## Grounding discipline (the gate for the deferred LLM narratives)

The deterministic authored-story (committed M-D) needs none of this — it only
projects what a human wrote. This gate applies to the **deferred** LLM
version, and it does not ship until every rule holds:

The LLM version crosses a line sivru has been deliberate about: search is one
deterministic instrument and `packages/observe/` makes **no** network calls.
An LLM is network + non-deterministic. That is allowed — the explainer lives
in `cli`, not `observe` — but only under rules that keep it from becoming the
rot-prone, untrustworthy doc the whole feature exists to kill:

1. **Opt-in.** Never default-on; an explicit flag / config.
2. **Grounded & verifiable.** Every generated sentence cites the symbol(s)
   or block(s) it rests on; a checker can re-verify a narrative against its
   citations and flag any claim whose source changed (reuse the DESIGN-0019
   provable-claim machinery).
3. **Cached & regenerated, never authored-in-place.** Same projection
   principle: the narrative is downstream of the code + blocks, regenerated,
   never hand-edited into the HTML.
4. **Privacy boundary intact.** No code leaves the machine except through the
   user's explicitly configured model endpoint; likely a separately
   installable package, never folded into `observe`.

If the grounding discipline is not airtight, the LLM version is slop with
nicer fonts. It does not ship until it is.

## Alternatives considered

- **Just keep polishing the static map (more diagrams, more views).** That is
  1.5x, not 10x — a nicer artifact nobody opens twice. Rejected as the
  primary direction; polish rides along.
- **Lead with M-D (narratives first).** Highest perceived value, but shipping
  a networked, non-deterministic generator before the grounding rails exist
  is how the feature becomes untrustworthy. Sequenced last on purpose.
- **One mega-release.** Rejected — each move is independently valuable and
  independently shippable; sequencing de-risks the one networked piece.

## Open questions

- M-A: which metric set is load-bearing vs noise? Start with
  instability/abstractness + cycles + hot spots; add by evidence. (owner:
  @pochadri)
- M-B: does the gate belong in `explain --diff --gate`, or in the coach
  `checkup` surface, or both? (owner: @pochadri)
- M-C: is the agent-context tool a new MCP method, or an extension of the
  existing `mcp__sivru__explain` / `find_related`? (owner: @pochadri)
- M-D: which package, and is the grounding-checker shared with DESIGN-0019's
  claim verifier? (owner: @pochadri)

## Acceptance criteria (committed plan)

- **Slice 3 (DESIGN-0018):** the feedback loop ships — annotate → patch →
  apply to the `@sivru` block / `.sivru/explainer.md` it was projected from.
- **Drift + hot spots + gate:** the model carries a hot-spot score
  (`churn × coupling`), cycle detection, and `@sivru`-invariant drift; the
  System page ranks an "Attention" list; `explain --project --diff` emits the
  architectural delta and `--gate` exits non-zero on a new cycle or a violated
  authored invariant. Deterministic.
- **Agent map:** an MCP tool returns a task/symbol-scoped model slice (intent
  + collaborators + drift/hot-spot flags) for an agent to ground on.
- **Authored-story:** a deterministic, readable system narrative assembled
  from authored `@sivru` intent + signatures + flows; missing intent shows the
  "add `@sivru`" affordance, never a guess. No network.

Deferred (not gating this plan): the academic metric suite; LLM-generated
narrative (must pass the Grounding discipline before it ships).

## Relationship to existing designs

- **DESIGN-0018** — the model + projection; the foundation all four build on.
- **DESIGN-0005/0006/0007** (coach loop) — the drift engine M-A surfaces and
  M-B gates on.
- **DESIGN-0019** (block reliability / provable claims) — the verification
  pattern M-D's grounding reuses.
- **DESIGN-0017/0021** (serving / authoring authored context) — the `@sivru`
  blocks every move reads from and (via the Slice-3 feedback loop) writes to.
