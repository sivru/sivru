# DESIGN-0007: Coach loop v3 — agent low-context edit

**Status:** Stub
**Targets:** v0.8.0
**Issue:** filed when v0.8 becomes next release
**Created:** 2026-05-08

## Problem

The architect-thinking coaching signal. Per the thesis (see
`project_sivru_architect_thinking_thesis` memory), AI generates code
at high velocity but without the architect's mental model unless we
mechanically place that model in front of it. This signal asks: did
the agent ACTUALLY load the architect's view of the symbol before
editing it?

Three concentric definitions of "context loaded," in increasing
order of architect-thinking depth:

1. **File context** — read the file's imports, tests, callers (the
   v0.5 `sivru explain` surface). This is the baseline: did the
   agent see the mechanical neighbourhood?
2. **Authored context** — for any edited symbol that carries a
   `@sivru` block, did the agent's session include a call to
   `sivru explain` or `mcp__sivru__explain` on that symbol? A block
   read is the cheapest proof the agent saw the architect's
   recorded intent (role, invariants, decisions, `revisit-if`).
3. **Decision context** — for any edit that touches a region the
   block's `decisions[]` references, did the agent's session
   include an acknowledgement of the relevant decision's
   `valid-while` clause? (Stretch goal; needs DESIGN-0017 drift
   wiring.)

A low-context edit on a block-bearing symbol that skipped layer (2)
is the **highest-risk** instance of this signal. It means the agent
edited a symbol with a recorded architectural decision without
loading that decision — exactly the failure mode the @sivru-block
investment was made to prevent. That class is treated as
strictly worse than a layer-(1)-only miss.

This is **AGENT context, not human review depth.** Sivru can detect
what the agent did but cannot see PR reviews on github.com or code
read in another tool. So the signal scopes narrowly: did the agent
have the relevant context loaded before editing?

Per the comprehension axis (see [WHY-SIVRU.md](../../WHY-SIVRU.md))
and the architect-thinking thesis, this is the highest-value
coaching signal long-term. Every edit the agent makes without the
architect's view is a comprehension burden it leaves to the human.

## Acceptance (from ROADMAP.md v0.8)

- Signal records, in increasing order of severity:
  - **Layer 1 (file context):** files imported by the edited file
    that were NOT read in this session; test files matching the
    edited file's name pattern that were NOT read in this session;
    call sites (1-hop callers) that were NOT read in this session
  - **Layer 2 (authored context):** for any edited symbol that
    carries a `@sivru` block, no `sivru explain` /
    `mcp__sivru__explain` call on that symbol earlier in the
    session. Tagged HIGHEST-RISK in the Checkup tab — the agent
    edited a symbol with recorded architectural intent without
    reading it.
- Surfaced in the Checkup tab alongside v0.6 + v0.7 signals
- FP rate < 15% on a labeled set
- Three-layer customization: per-path skips, threshold tuning,
  custom rule extensions

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** descriptive only — records what was read
   vs. what wasn't. No flag fires by default; user tunes via JSON
   to opt into a flag.
2. **Declarative override:** `.sivru/diagnostics.json` accepts
   `{ "minImportReadRatio": 0.5, "skipPaths": ["*.test.ts"],
   "severity": "warn" }`.
3. **Code-level extension:** `.sivru/diagnostics/*.ts` files
   register team-specific rules (e.g., for files in `auth/`,
   require reading all imports + the security-review skill loaded).

## Open questions

- "Imported by" detection requires static analysis of imports, which
  we get from tree-sitter (v0.2). Good — the dependency is right.
- Should we count partial reads? If the agent did `Read(file, offset:
  0, limit: 50)` on a 500-line file, that's a partial read — does
  that count? Probably yes if any reading is better than none, but
  decide during design.
- "Callers" detection requires either an index of call sites or
  on-the-fly grep. Probably reuse the same call-graph computation
  from `sivru explain` (v0.5).
- How does this interact with `sivru explain` itself? If the agent
  ran `sivru explain` before editing, that should count as
  "context was loaded" even if specific files weren't Read'd.

## Status note

This is a Stub. Full design lands when v0.8 becomes the next
release.
