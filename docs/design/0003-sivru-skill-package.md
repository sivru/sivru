# DESIGN-0003: `@sivru/skill` package

**Status:** Stub
**Targets:** v0.4.0
**Issue:** filed when v0.4 becomes next release
**Created:** 2026-05-08

## Problem

Today, after `npm install -g @sivru/cli` + `claude mcp add sivru`,
Claude has the sivru tool registered but no policy for *when* to
call sivru.search vs Grep / Read. The agent figures out by trial and
error, often defaulting to Grep first because that's what it's been
trained on.

A SKILL.md teaches Claude when to reach for which tool. Sivru's
runtime is more useful when paired with the skill that documents the
playbook. Without the skill, sivru is "another tool"; with it,
sivru becomes part of a documented workflow.

## Acceptance (from ROADMAP.md v0.4)

- `@sivru/skill` published as a separate npm package, installable
  via `npm install -g @sivru/skill` or copyable into
  `~/.claude/skills/sivru/`
- SKILL.md tells Claude:
  - When to call sivru.search (natural-language, behavioral queries)
  - When to call Grep instead (exact identifier lookups)
  - When to call sivru.find_related (after editing)
  - That sivru.observe exists for retrospective session analysis
- README on the skill explains install + the runtime-vs-skill split

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** the SKILL.md ships as a single file with
   curated guidance.
2. **Declarative override:** N/A — SKILL.md is itself the
   declarative content. Users edit their local copy.
3. **Code-level extension:** N/A — skills are prompt content, not
   code.

The skill IS the customization layer for this concept. Users can
copy + edit; teams can ship their own variants.

## Open questions

- Should the skill ship inside the existing `@sivru/cli` package or
  as a separate `@sivru/skill` package? Separate is cleaner
  (skills follow their own lifecycle); bundled is one-step install.
- How specific to make the "when to call X" rules? Too prescriptive
  reads as opinionated; too vague reads as useless.
- Should sivru ship a `claude skill add` command that installs it
  via the CLI? Or just instructions to copy the file?
- Versioning: when sivru's MCP surface changes (e.g., a new tool
  ships), how does the skill stay in sync?

## Status note

This is a Stub. Full design lands when v0.4 becomes the next
release.
