# Sivru — positioning & messaging

The source of truth for how sivru is described everywhere: the README hero,
the GitHub/npm descriptions, a landing page, a launch post, a conference bio.
[`GOALS.md`](GOALS.md) is *why sivru exists* (the north star, long-form).
[`WHY-SIVRU.md`](WHY-SIVRU.md) defends the search instrument. This file is the
compressed, audience-facing version — the words, ranked, ready to paste.

House rule (matches the project voice): **plain sentences, no hype, no jargon
padding.** sivru's credibility is "benchmark me before you trust me." Copy that
oversells contradicts the product.

---

## The one line

> As AI drives the cost of *writing* code toward zero, sivru keeps the cost of
> *understanding* it from going to infinity.

Shorter, for a tagline slot:

> **The comprehension layer for AI-written code.** Local, MCP-native.

## The category claim

Every coding tool — Cursor, Copilot, Claude Code, Codex — *produces* code at
high velocity. None of them owns the question that velocity creates: **does
anyone still understand this?** That category has no incumbent. sivru claims it.

"Better code search" is a contested category with a strong skeptic (Anthropic:
agentic search beats indexed retrieval). sivru does not fight there. Search is
one *instrument*; comprehension is the goal. Lead with comprehension, never with
"faster RAG."

## Who it's for

- Engineers who now ship most of their code through agents and can feel the
  comprehension debt piling up.
- Teams where review can't keep pace line-by-line at agent velocity.
- Anyone accountable for a codebase that's growing faster than anyone can read.

## The pain (lead with this — it's felt, not abstract)

The failure state is already arriving: a codebase nobody — human or agent —
actually understands, evolving faster than anyone can comprehend it.

- The agent confidently "fixes" something that was deliberate.
- Incidents nobody can diagnose; refactors nobody dares start.
- Security blast-radius nobody can map.
- The one engineer who knew *why* left, and the why left with them.

The most visceral, lead-with-it line: **"the agent confidently broke something
intentional."** Every developer using agents has felt it.

## Why now

Code creation just got cheap; code comprehension just got expensive. The gap is
new, widening, and has no owner. Documentation decays from the day it's written;
an agent's understanding dies when the session ends. The moment the cost curves
crossed is the moment a comprehension layer became necessary.

## The differentiation (what no one else holds)

Uniqueness is the *combination*, not one feature: in-repo · symbol-level ·
decision-with-time · agent-consumed · drift-checked · tool-neutral. Two edges are
the sharpest:

1. **Decision memory with a half-life.** A `@sivru` block records a decision as
   `chose / because / valid-while / revisit-if` — attached to a symbol,
   machine-readable, with an *expiry condition*. Nothing else records a decision
   with a clock. It's the difference between an agent making a judgment call and
   making a blind edit.
2. **It gets more correct over time.** Every other doc system drifts from the day
   it's written. sivru's feedback loop writes corrections back into the source,
   and drift-checking flags rot. A comprehension artifact designed to *improve*
   with age instead of decay is the actual moat.

The shipped proof of the moat (v0.14): **nobody else gates a PR on authored-intent
drift.** sivru diffs the architecture of a change and blocks the PR that breaks an
`@sivru` invariant whose guard test just disappeared. That is a thing no other
tool can do, because no other tool holds the authored intent to check against.

## What you can trust (proof points, not adjectives)

- **It's a projection of facts, never AI-generated.** Structure from the parser,
  churn from git, intent from text a human wrote. sivru never invents an
  explanation it can't trace to your repo.
- **Local. No network egress, ever** — enforced by a lint rule + a runtime fetch
  spy, not a promise.
- **MCP-native and tool-neutral.** Any agent that speaks MCP uses it; it outlives
  any single agent tool — Claude Code, Cursor, Codex all come and go, the repo
  stays.
- **Benchmarked in the open.** NDCG@10, agent-task token economy, a perf gate,
  raw data committed. "Benchmark me before you trust me."

## Message hierarchy (what to lead with, by surface)

- **GitHub repo / npm:** the tagline + "does anyone still understand this?" + the
  v0.14 moat (the drift gate) in one breath.
- **Landing hero:** the one line (writing→zero / understanding→infinity), then
  the pain ("the agent broke something intentional"), then the one screenshot
  that proves it (the explainer map, or a gate failing on a real PR).
- **Launch post:** the cost-curve crossing → the failure state → the demo → the
  moat → benchmarks.
- **To a skeptic ("isn't this just RAG?"):** point at WHY-SIVRU.md; search is one
  instrument, comprehension is the goal.

## Paste-ready copy

- **Tweet / Show HN one-liner:** "Code creation is cheap now; understanding it
  isn't. sivru is a local, MCP-native comprehension layer for AI-written code —
  it records *why* the code is the way it is, keeps it current, and can block the
  PR that breaks a decision nobody re-read."
- **GitHub About (≤120 chars):** "The comprehension layer for AI-written code.
  Local, MCP-native. Records why code is the way it is — and gates the PR that breaks it."
- **npm description:** "Sivru — the comprehension layer for AI-written code:
  authored-intent blocks, a repo-wide explainer model, and an architectural
  drift gate. Local, MCP-native."
- **One sentence at a dinner:** "When an AI writes most of your code, sivru is the
  thing that still knows why it's shaped that way — and stops the agent from
  blindly undoing a decision."

## Words to avoid

- Don't call it "RAG" or lead with "code search" (cedes the category to the
  skeptic; undersells the goal).
- No hype words: comprehensive, robust, revolutionary, seamless, powerful,
  game-changing. The product's pitch is honesty; the copy must match.
- Don't claim it sees *all* work on a repo — it sees the agent sessions it can
  read. Say so.
