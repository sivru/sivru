# DESIGN-0011: Codex adapter

**Status:** Stub
**Targets:** v0.12.0
**Issue:** filed when v0.12 becomes next release
**Created:** 2026-05-08

## Problem

After Cursor (v0.11), Codex CLI is the third major surface
practitioners use. Once the Cursor pattern is established, Codex
should be ~1 week of work — same `SessionSource` interface, third
adapter.

The cross-tool story is "all three" or it's incomplete; v0.12
closes the gap.

## Acceptance (from ROADMAP.md v0.12)

- New `@sivru/observe` adapter for Codex CLI sessions
- All `@sivru/observe` consumers work on Codex sessions
- All coaching signals fire on Codex sessions same as Claude /
  Cursor

## Customization shape

Same as DESIGN-0010 (Cursor adapter):

1. **Built-in default:** auto-detects Codex session directory at
   the OS-standard path.
2. **Declarative override:** `~/.config/sivru/sources.json` —
   `{ "codex": { ... } }`.
3. **Code-level extension:** custom `SessionSource` impls already
   work.

## Open questions

- Codex CLI session schema as of v0.12 may differ from Cursor's;
  the abstractions in v0.11 should generalize.
- Per-tool signal nuances: Codex tools differ from Claude Code's
  Grep/Read/Edit; mapping to common signal definitions may need
  adjustment.

## Status note

This is a Stub. Full design lands when v0.12 becomes the next
release.
