# DESIGN-0008: Skill recommender

**Status:** Stub
**Targets:** v0.9.0
**Issue:** [#18](https://github.com/sivru/sivru/issues/18)
**Created:** 2026-05-08

## Problem

The skill ecosystem is genuinely overgrown. Most users don't know
what skills exist for their stack. The few who try install too many
(skill bloat) or pick wrong ones (skills that don't change Claude's
reasoning, per the practitioner literature). Getting the right
skills loaded for your work is a manual research project.

Sivru already has the two pieces of data needed to recommend:
- The user's repo (languages, frameworks, deps from package.json
  / go.mod / etc.)
- The user's recent sessions (what tools the agent used, what
  failed)

A `sivru recommend skills` command turns that into a ranked list:
"you're on TS/React, your last 5 sessions had test failures the
agent didn't recover from → install vitest-runner and a
react-testing-library skill."

## Acceptance (from ROADMAP.md v0.9)

- `sivru recommend skills` ranks built-in catalog entries by repo
  + session matchers
- Output: ranked list with reasons; `--json` for tooling
- Three-layer customization including remote catalog support so
  teams can maintain shared catalogs at a URL
- Built-in catalog of ~30 entries from the practitioner literature

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** ~30 entries in
   `packages/cli/src/lib/skill-catalog/built-in.ts`.
2. **Declarative override:**
   - `~/.config/sivru/skills.json` — user-added entries (private,
     personal-use skills not in public catalog)
   - `.sivru/skills.json` — project-local; overrides user-global
     (e.g., team-only skills)
   - `--catalog https://internal/skills.json` — load from URL
     (one-shot; only network call this feature ever makes;
     observe boundary unaffected)
3. **Code-level matchers:** `.sivru/skills/*.ts` files write
   custom matchers for company-specific recommendation logic.

Type stub already exists at
`packages/cli/src/lib/skill-catalog/types.ts`.

## Open questions

- Curating 30 built-in entries: which 30? Start with the practitioner
  literature's frequently-recommended skills; document the criteria.
- "Recently failed" pattern matching: how to detect that the agent
  failed at task X in session Y? Use the v0.7 looped-on-error
  signal as input? Or simpler heuristic: if the user wrote a follow-
  up message saying "that didn't work" within 30s of an agent
  response.
- Should the recommender also be available as an MCP tool so the
  agent can self-recommend mid-session? Probably yes, but that's
  v0.9.x patch.
- Remote catalog auth: company catalogs on private URLs need a
  way to authenticate. Token-in-config? `Bearer` header from env
  var?

## Status note

This is a Stub. Full design lands when v0.9 becomes the next
release.
