# README assets

**`demo-map.png`**, **`demo-gate.png`** — the hero stills (the two demo beats:
the map, then the gate). Generated from the `acme` demo repo
([`../../marketing/demo/`](../../marketing/demo/)); the README embeds both under
the hero. Regenerate by rebuilding the CLI, running `marketing/demo/make-demo.sh`,
then `sivru explain --html` for the map and `marketing/demo/record-beat2.sh` for
the gate (crop the dead space off the stills).

**`demo.gif`** — the animated hero (map → gate, ~20s). Not committed yet. Record
it following [`../../marketing/demo/STORYBOARD.md`](../../marketing/demo/STORYBOARD.md),
save it here as `demo.gif`, then swap the two `<img>` stills in the README for it.
Keep it tight (< ~3 MB) — `gifski` / `agg` produce small, crisp GIFs.
