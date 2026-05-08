# DESIGN-0006: Coach loop v2 — looped-on-error

**Status:** Stub
**Targets:** v0.7.0
**Issue:** [#16](https://github.com/sivru/sivru/issues/16) (broader scope; this is the v0.7 subset)
**Created:** 2026-05-08

## Problem

A common high-cost failure mode: the agent grep's the same pattern
repeatedly because the error keeps reproducing. It re-reads the same
files, runs the same lint, gets the same error, tries a similar fix.
After five iterations the session has burned 5,000 tokens making no
progress.

Today this is invisible to the user mid-session — the agent looks
busy. Sivru already has the data (every Grep / Read tool call is in
the session jsonl). We just need to detect the pattern and surface
it.

## Acceptance (from ROADMAP.md v0.7)

- New signal: agent grep'd same pattern 5+ times within 5+ minutes
  AND the file mentioned in the matching grep results is repeated
  across iterations (i.e., the agent is reading the same code over
  and over without progress)
- Surfaced in the Checkup tab alongside skill drift (v0.6)
- Combined FP rate (skill drift + looped-on-error) < 15% on a
  labeled set
- Skill drift signal hasn't regressed

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** 5-iteration / 5-minute window with
   same-file repetition.
2. **Declarative override:** `~/.config/sivru/diagnostics.json` and
   `.sivru/diagnostics.json` accept iteration / time-window /
   severity tuning per signal.
3. **Code-level extension:** `.sivru/diagnostics/*.ts` files
   register custom signal rules.

Type stub already exists at `packages/observe/src/diagnostics/types.ts`.

## Open questions

- "Same pattern" — is it the literal regex string, or do we
  fuzzy-match across iterations (the agent slightly tweaks the
  pattern each time)? Start with literal; revisit if FP rate is
  too high.
- The signal should NOT fire when the agent IS making progress
  (e.g., narrowing the search). Heuristic: number of unique files
  touched is decreasing across iterations = progress; staying flat
  = stuck. Test on real labeled sessions before committing.
- How does the user respond to the signal? "We detected this; what
  did you do next?" telemetry would tune the signal but breaks the
  privacy boundary. Skip; just surface and let users tune.

## Status note

This is a Stub. Full design lands when v0.7 becomes the next
release.
