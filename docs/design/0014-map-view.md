# DESIGN-0014: Map view in observe-ui

**Status:** Stub
**Targets:** v0.15.0
**Issue:** filed when v0.15 becomes next release
**Created:** 2026-05-08

## Problem

After v0.4–v0.13 the observe-ui has accumulated a lot of
information per-session (events, savings, replay, costs, bench).
What's missing: a **repo-level overview** that shows where activity
is going, which areas are stale, where coaching signals concentrate.

This is the visualization layer for the comprehension axis. Not
"comprehension scoring" (we can't measure human comprehension —
sivru only sees agent activity), but agent-activity heat layered
over git churn — together they show where the codebase is
changing fastest and where engagement is shallow.

## Acceptance (from ROADMAP.md v0.15)

- New "Map" tab in observe-ui
- Heatmap by file: agent activity (sessions touching the file in
  last N days) × git churn (commits in last N days)
- Filter: time window, project, tool source
- Honest axes labeled: "agent activity" not "comprehension"
- Exports: CSV / JSON

## Customization shape

Per the three-layer rule (CONTRIBUTING.md):

1. **Built-in default:** heatmap with two axes (activity × churn);
   30-day window.
2. **Declarative override:** `~/.config/sivru/map.json` accepts
   custom layers (e.g., "files modified by AI without test updates"),
   different time windows, hide-paths globs.
3. **Code-level extension:** custom layer definitions via TS for
   team-specific risk dimensions.

## Open questions

- How to handle very large repos (10k+ files)? The heatmap doesn't
  scale visually; need binning by directory or top-N file
  selection.
- "Engagement depth" — can we show how DEEP an interaction was
  per file? E.g., agent read 10 lines vs. read whole file. Adds
  an axis but the data is there.
- Combining session activity with git churn requires git data;
  document the dependency. Same as `sivru explain`.
- Should the Map respond to clicks (drill into a file's session
  history)? Probably; defer to design phase.

## Status note

This is a Stub. Full design lands when v0.15 becomes the next
release.
