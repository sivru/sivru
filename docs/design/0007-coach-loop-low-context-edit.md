# DESIGN-0007: Coach loop v3 — agent low-context edit

**Status:** Stub
**Targets:** v0.8.0
**Issue:** filed when v0.8 becomes next release
**Created:** 2026-05-08

## Problem

The comprehension-axis coaching signal. The agent edits a file
without reading its imports, tests, or callers in the same session.
That's a low-context edit — the agent is shooting blind. Maybe it
got lucky; maybe it broke something invisible.

This is **AGENT context, not human review depth.** Sivru can detect
what the agent did but cannot see PR reviews on github.com or code
read in another tool. So the signal scopes narrowly: did the agent
have the relevant context loaded before editing?

Per the comprehension axis (see [WHY-SIVRU.md](../../WHY-SIVRU.md)),
this is the highest-value coaching signal long-term. Every edit the
agent makes without context is a comprehension burden it leaves to
the human.

## Acceptance (from ROADMAP.md v0.8)

- Signal records:
  - Files imported by the edited file that were NOT read in this
    session
  - Test files matching the edited file's name pattern that were
    NOT read in this session
  - Call sites (1-hop callers) that were NOT read in this session
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
