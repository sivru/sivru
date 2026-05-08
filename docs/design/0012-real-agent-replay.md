# DESIGN-0012: Real-agent replay

**Status:** Stub
**Targets:** v0.13.0
**Issue:** [#14](https://github.com/sivru/sivru/issues/14)
**Created:** 2026-05-08

## Problem

Today's `sivru observe replay` is offline counterfactual analysis:
it walks the recorded session events and computes "if sivru had
been here, here's what would have changed." Layer 2 in DESIGN.md
terms.

That's defensible for token-savings estimation but can't answer:
"did the agent actually solve the user's problem?" or "did sivru
change the agent's reasoning quality?" Those need re-running the
session through the real Anthropic API with vs. without sivru's
tools available.

This is also the foundation for v0.14 (skill efficacy bench).
Skill A/B testing requires real-agent runs; v0.13 builds the
infrastructure; v0.14 uses it.

## Acceptance (from ROADMAP.md v0.13)

- New CLI command: `sivru observe replay-live <session-id>`
- Reads a recorded session, replays through `@anthropic-ai/sdk`
  with sivru's tools available (one run) and without (another run)
- Reports: token / turn / wall-time delta + (optional) LLM-as-judge
  score on whether the output meets the original session's
  outcome
- Idempotency + retry handling for partial failures
- API key handling via `ANTHROPIC_API_KEY` env var; clear "this
  costs API tokens" warning before any run
- Opt-in flag (`--confirm-cost`) so it can never accidentally fire

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** runs both arms (with sivru, without
   sivru); reports token + turn + wall-time deltas.
2. **Declarative override:** `~/.config/sivru/replay.json`
   accepts `{ "model": "claude-sonnet-4-5", "judge": "off",
   "maxRetries": 3 }`.
3. **Code-level extension:** custom judges via a `ReplayJudge`
   interface (LLM-as-judge implementations the user can plug in).

## Open questions

- Cost-per-replay can be substantial. Should we cap per-session
  cost? Per-run cost? Print a budget estimate before running?
- Idempotency: if the API call partially fails, can we resume?
  Probably yes via Anthropic's session resumption mechanism;
  needs to be designed in.
- Token counting: track input + output + cache reads + cache
  writes; report all four in the comparison.
- Reproducibility: real-agent runs are non-deterministic.
  Multiple runs with bootstrap CIs? Or single run with a clear
  "this is one sample" caveat?

## Status note

This is a Stub. Full design lands when v0.13 becomes the next
release.
