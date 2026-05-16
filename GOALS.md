# Sivru — Goal, uniqueness, and the test every release must pass

This is sivru's north star. [ROADMAP.md](ROADMAP.md) is *how*;
[WHY-SIVRU.md](WHY-SIVRU.md) is the honest competitive defense of one
instrument (search). This file is *why sivru exists at all*. If a
release does not move the goal below, it does not get a version slot.

## The goal

**One line.** As AI drives the cost of *writing* code toward zero,
sivru keeps the cost of *understanding* it from going to infinity.

**Thorough.** Sivru keeps a codebase comprehensible — to the agents
writing it and the humans accountable for it — by making
comprehension a durable, shared, queryable asset of the repo itself.
Not a thing that lives in one engineer's head and dies when they
leave. Not a thing that lives in an agent's context window and dies
when the session ends. Sivru records *why the code is the way it is*,
keeps that record current as the code changes, and serves it to the
next agent or human at the moment it matters — the edit.

**The failure state sivru exists to prevent** is concrete and already
arriving: a codebase nobody — human or agent — actually understands,
evolving faster than anyone can comprehend it. Incidents nobody can
diagnose. Refactors nobody dares start. Security blast-radius nobody
can map. Agents confidently "fixing" things that were deliberate.

Code search and session observability are not the goal. They are the
first two instruments of it.

## Why this is the right goal, and why it is open

"Better retrieval for code" is a contested category. Anthropic's
public position — agentic search beat indexed retrieval in their
tests — is correct on average, and a tool whose founding pitch is
"benchmark me before you trust me" has found an honest niche, not a
goal.

But that claim is about *retrieval*. It says nothing about
*comprehension*. Cursor, Copilot, Claude Code, Codex — every one of
them *produces* code at high velocity. None of them owns the question
that velocity creates: **does anyone still understand this?** That
category has no incumbent. Sivru claims it.

## What is unique

Uniqueness is never one feature; it is a combination no one else
holds. Sivru's comprehension layer is:

| | in-repo | symbol-level | decision + *time* | agent-consumed | drift-checked | tool-neutral |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| grep / agentic search | — | — | — | — | — | yes |
| Javadoc / TSDoc / docstrings | yes | yes | **no** | weak | **no** | no |
| Architecture Decision Records | yes | **no** | partial | **no** | **no** | yes |
| code-intelligence / nav servers | — | yes | — | — | — | no |
| IDE / agent session context | **no** | — | — | yes | — | **no** |
| AI auto-doc generators | yes | yes | **no** | — | **no** | varies |
| **sivru** | **yes** | **yes** | **yes** | **yes** | **yes** | **yes** |

Two points are the sharpest edge:

1. **The decision with a clock.** A `@sivru` block records decisions
   as `chose / because / valid-while / revisit-if` — attached to a
   symbol, machine-readable. Nothing else records a decision *with an
   expiry condition*. It is the difference between an agent making a
   judgment call and making a blind edit, and it lets sivru later
   surface "every decision whose `revisit-if` is now true." This is
   not documentation. It is decision memory with a half-life.

2. **It gets more correct over time.** Every other doc system drifts
   — it degrades from the day it is written. Sivru's feedback loop
   writes corrections back to the source blocks, and drift-checking
   flags rot. A comprehension artifact designed to *improve* with age
   instead of decay is the actual moat. Because it is in-repo and
   tool-neutral, it also outlives any single agent tool — Claude
   Code, Cursor, Codex all come and go; the repo stays.

## Why it is valuable to users

Ordered by how viscerally a user feels it:

1. **Fewer "the agent confidently broke something intentional"
   incidents.** The agent reads the decision *before* editing. Every
   developer using agents has felt this failure; this is the
   highest-value outcome.
2. **Onboarding collapses** — days to minutes. A new human or a fresh
   agent opens the explainer, drills down, reads the decisions.
3. **The reasoning survives the author.** When the engineer who made
   a call leaves, or the session ends, the *why* is still in the
   repo. Institutional memory stops evaporating.
4. **Review becomes possible again.** Human review cannot keep pace
   line-by-line at agent velocity. Decision-aware review can: "this
   PR touched a symbol with decision X, valid-while Y — is Y still
   true?"

## How we will know — the north-star metric

The goal is an outcome: **edits are made with comprehension.** The
metric for it matures as the capability to measure it ships.

- **Leading proxy (from v0.6).** *Decision coverage* — of
  load-bearing symbols (public API, churn-heavy, agent-edited), the
  share carrying a `@sivru` block with at least one decision. Rising
  = the layer is being built and used.
- **The real metric (from v0.11).** *Low-context-edit rate* — of
  agent edits sivru observed, the share made without the agent
  reading the edited symbol's `@sivru` block, tests, callers, or
  imports in the same session. Falling = edits are informed.

Honest scope: sivru sees only the agent sessions it can read (see
ROADMAP principle 7). The metric describes observed sessions, not all
work on the repo. We do not inflate it.

## How this shapes the roadmap — the goal test

Every version slot is one of four classes. The class is not a
ranking; it is a statement of *what the version is for*, so execution
stays honest about which work is the goal and which work serves it.

- **Foundation** — the floor the rest stands on. Not optional, not
  the goal.
- **Spine** — *is* the goal. Builds, delivers, or maintains the
  comprehension layer.
- **Supporting** — improves an instrument (search) or extends reach.
  Real value; not the goal.
- **Proof** — demonstrates the value is real to the outside world.

**The goal test.** Before any item gets a version slot, it must
answer one question: *how does this make the codebase more
comprehensible, or keep comprehension honest?* An item that cannot
answer it is a patch, not a version.

## Honest risks

- **Comprehension demos worse than token savings.** A number ("saved
  57% of tokens") is visceral; "your codebase stayed comprehensible"
  is not, immediately. The explainer is the demo-able artifact; lean
  on it.
- **The authored layer needs authoring.** Empty `@sivru` blocks mean
  empty value. Mitigation: agents author blocks incrementally via the
  skill, seeded where work actually happens — but adoption is a real
  curve, not a given.
- **It is a longer build.** Search shipped at v0.1; the comprehension
  goal fully lands across v0.6–v0.11. The roadmap's job is to keep
  every release in between visibly on the spine.
