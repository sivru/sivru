# DESIGN-0010: Cursor adapter

**Status:** Stub
**Targets:** v0.11.0
**Issue:** filed when v0.11 becomes next release
**Created:** 2026-05-08

## Problem

Sivru today reads only Claude Code session files. That makes it a
"Claude Code accessory." Most practitioners run 2–4 coding tools;
the cross-tool view is what lets sivru become a cockpit, not an
accessory.

The `SessionSource` interface in `@sivru/observe` was designed
neutral from day one — adding Cursor is mostly writing the second
adapter, not changing the core. After v0.6–v0.8 (coaching loop) we
have a proven loop on Claude Code; expanding to Cursor lets that
loop apply across the user's whole agent stack.

## Acceptance (from ROADMAP.md v0.11)

- New `@sivru/observe` adapter that reads Cursor session files
  (location TBD per current Cursor schema)
- All existing `@sivru/observe` consumers (savings estimator,
  replay, coaching signals) work on Cursor sessions same as
  Claude
- `sivru observe` lists Cursor sessions alongside Claude
- `sivru session show` works on Cursor session ids

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** auto-detects Cursor session directory
   at the OS-standard path (`~/.cursor/...` or whatever Cursor
   uses).
2. **Declarative override:** `~/.config/sivru/sources.json`
   accepts `{ "cursor": { "path": "/custom/path", "enabled": true } }`.
3. **Code-level extension:** the `SessionSource` interface is
   already public; users can write a custom source for any
   tool.

## Open questions

- What's Cursor's actual session schema as of v0.11 (which may be
  several months out)? May change before we land.
- Some Cursor sessions are partially transcripts and partially tool
  calls; mapping to `SivruEvent` requires care for the parts
  that don't fit cleanly.
- Cursor's privacy model differs from Claude Code. Are there
  paths in Cursor session files that we should NOT read?
- How does the coach loop's signal definitions interact with
  Cursor's tool surface (which differs from Claude Code's)? Might
  need per-tool signal variants.

## Status note

This is a Stub. Full design lands when v0.11 becomes the next
release.
