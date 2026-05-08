# DESIGN-0013: Skill efficacy bench

**Status:** Stub
**Targets:** v0.14.0
**Issue:** filed when v0.14 becomes next release
**Created:** 2026-05-08

## Problem

The Claude Code skill ecosystem has dozens of skills with varying
quality. Practitioner literature has been pointing out that some
popular skills don't actually change the agent's behavior — they
look like checklists more than capabilities. There's no neutral,
trusted source that benchmarks skill efficacy.

Sivru's bench infrastructure is already shaped for A/B comparisons
(W0 NDCG@10 corpus, agent-task harness). Extend the harness to
measure: same agent task, with skill loaded vs. without skill
loaded. Score on whether the output meets the spec.

This is sivru's moat play. Whoever publishes the trusted skill
efficacy table first becomes the curator. Network effect compounds:
skill authors come to validate their skills; end users come to
choose skills.

## Acceptance (from ROADMAP.md v0.14)

- A/B harness in `benchmarks/skills/`
- For each skill in scope: run N agent tasks with skill loaded,
  N without; LLM-as-judge scores task completion
- First publish ~10 popular skills A/B'd
- Results in `BENCHMARKS.md` and the Bench tab of observe-ui
- Methodology fully open-source: anyone can reproduce
- Bootstrap 90% CIs on every metric (matches existing bench
  rigor)

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** ~10 curated skills; ~5 agent tasks per
   skill; standard judge.
2. **Declarative override:** `benchmarks/skills/config.json`
   defines which skills + which tasks. Users add their own skills
   to the same shape.
3. **Code-level extension:** custom judges (per the `ReplayJudge`
   from v0.13); custom task generators.

## Open questions

- What constitutes "task completion"? Predefined oracle (test
  passing) when possible; LLM-as-judge otherwise. Document the
  judge.
- How to choose the first ~10 skills? Most-installed? Most-
  recommended? Most-controversial? Probably a mix biased toward
  high-traffic skills where the answer matters most.
- Cost: real-agent A/B with N tasks per skill = lots of API
  calls. Budget? Sponsor? Treat the public table as a quarterly
  thing rather than continuously updated?
- Methodology: how to handle skills that interact with other
  skills (one skill's effect depends on another being loaded)?
  Test combinations? Document the limitation?

## Status note

This is a Stub. Full design lands when v0.14 becomes the next
release.
