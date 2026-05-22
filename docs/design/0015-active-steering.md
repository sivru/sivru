# DESIGN-0015: Active steering, conservative

**Status:** Stub
**Targets:** v0.16.0
**Issue:** filed when v0.16 becomes next release
**Created:** 2026-05-08

## Problem

v0.6–v0.8 ship coaching signals as descriptive (what happened,
surfaced post-hoc). v0.16 graduates one signal — the highest-
precision one as proven by months of FP data — to **pre-action
steering.** A PreToolUse hook fires when the agent is about to edit
a symbol whose recorded architectural intent forbids or constrains
the change, and injects a JSON nudge.

Per the architect-thinking thesis: the most precise pre-action
signal is not "is the right skill loaded" — that's user-side
configuration drift. It is "does this edit violate a recorded
architectural boundary the author already wrote down." `@sivru`
blocks (v0.6) record exactly this: `decisions[]` with
`revisit-if` clauses that say "this choice holds while X; revisit
when Y." When the agent's planned edit triggers Y, the architect
already signed the nudge — sivru just delivers it.

Concrete first signal: the edit's diff appears to violate a
`revisit-if` condition (broken-collaborator class) OR appears to
rewrite a `chose` clause's referenced structure. Secondary signal:
skill-presence at risk-tagged paths (the v0.4 routing concern).
Skill-presence is included but not the lead signal — it is user
configuration; the architect's recorded boundary is the source
of truth.

This is dangerous. False positives turn into noise that makes the
user disable the hook entirely. Ship only after months of field
data have proven which signal is precise enough, and only against
the architect's recorded constraints (which the author opted into
by writing the block).

## Acceptance (from ROADMAP.md v0.16)

- One PreToolUse hook ships, scoped to the most-precise signal
  from the v0.6–v0.8 set (likely "editing risk-tagged paths
  without the security-review skill loaded")
- Opt-in flag (default off)
- FP rate < 5% on a labeled set (much stricter than the post-hoc
  signals' 10–15%)
- Per-pattern disable so users tune which paths the hook fires on
- Nudges fire BEFORE the edit, not after

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** one hook, opt-in, scoped narrow.
2. **Declarative override:** `~/.config/sivru/steering.json` and
   `.sivru/steering.json` accept hook enable/disable per pattern,
   custom risk-path globs, message overrides.
3. **Code-level extension:** custom hook handlers via the
   `SteeringHook` interface — write your own pattern, control
   message + JSON shape returned to Claude Code.

## Open questions

- Which signal is precise enough for v0.16? Decide based on real
  v0.6–v0.8 field data — not now.
- How does the user trust the hook isn't going to derail their
  work? Visible audit trail in observe-ui showing every hook
  firing and the action that followed.
- Multiple steering patterns: should they compose (multiple
  hooks active at once) or are they exclusive (one pattern at a
  time)? Compose — but limit total nudge frequency to N per
  session.
- Privacy: hooks see the file path the agent is about to edit.
  That's already in the session jsonl; no new privacy surface.

## Status note

This is a Stub. Full design lands when v0.16 becomes the next
release. The "what counts as precise enough" question must be
answered by v0.6–v0.8 field data first; do not design this
without that data in hand.
