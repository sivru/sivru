# The sivru demo — storyboard (map → gate)

The one artifact that makes a skeptical engineer stop scrolling. **Two beats,
~20 seconds**, captioned from the locked positioning ([`../../POSITIONING.md`](../../POSITIONING.md)):

> "The comprehension layer for AI-written code." — and the moat: it **blocks the
> PR that breaks a decision nobody re-read.**

The demo proves both halves: *what it is* (the map) and *why you care* (the gate).

## Setup (once)

```bash
./make-demo.sh            # builds /tmp/sivru-demo: clean `main` + an `agent/refactor-session` branch
sivru explain --html --repo=/tmp/sivru-demo --out=/tmp/sivru-demo-map.html   # beat-1 artifact
```

`acme` is a tiny service: `auth/session.ts` and `billing/charge.ts`, each with a
`@sivru` block recording the *why* and linked to the test that guards it.

## Beat 1 — the map (~6s) · "what it is"

Open `/tmp/sivru-demo-map.html`. Drill: **System → auth → `validateSession`**.
Land on its `@sivru` block — the decision in plain sight:

> *invariant:* an expired token is always rejected (24h, no exceptions)
> *decision:* chose hard 24h expiry **because** a stolen token must stop working
> within a day — **revisit-if** we add server-side revocation.

**On-screen caption:** *"sivru maps your repo — and the intent humans wrote into it."*

The point the viewer absorbs in 6 seconds: this isn't a file tree, it's the
*reasons*, attached to the code, machine-readable.

## Beat 2 — the gate (~8s) · "why you care"  ← the money shot

Terminal. We're an agent that just "tidied up" `session.ts` and renamed a test.
Run the gate against `main`:

```bash
cd /tmp/sivru-demo && git checkout agent/refactor-session
sivru explain --project --diff --gate --base=main
```

Output (let it sit on screen):

```
Architectural gate vs main:
  FAIL — 1 gateable regression(s):
    linkage  broken linkage: validateSession — no `it("rejects an expired token", ...)` or declaration
             in test/auth.test.ts (enforced-by test/auth.test.ts::rejects an expired token)
  Suppress an accepted finding by adding its key to .sivru/gate-allowlist:
    linkage:symbol:src/auth/session.ts#validateSession:test/auth.test.ts::rejects an expired token
exit=1
```

**On-screen caption:** *"The agent's refactor deleted the test guarding 'expired
tokens are rejected.' The code still compiles. sivru blocks the PR."*

This is the visceral beat — a real security guarantee silently removed, caught by
a CI check nobody else has.

## Closing card (~3s)

Plain card, the locked lines:

> **sivru** — the comprehension layer for AI-written code.
> Records why your code is the way it is, and blocks the PR that breaks it.
> `npm install -g @sivru/cli` · github.com/sivru/sivru

## How to record

Tools (once): `brew install asciinema agg`.

- **Terminal beat (beat 2) — automated:** `./record-beat2.sh`. It regenerates the
  demo, parks it on `agent/refactor-session`, records the gate command typed at a
  readable pace, and renders `beat2.gif` via `agg` — no live typing, no trimming.
  Uses this repo's local build (so the output matches the storyboard above); falls
  back to a global `sivru`. The `.cast`/`.gif` it writes are gitignored.
- **Map beat (beat 1) — manual:** generate the artifact first —
  `sivru explain --html --repo=/tmp/sivru-demo --out=/tmp/sivru-demo-map.html` —
  then screen-record the browser (QuickTime on macOS) drilling
  System → auth → `validateSession`, and trim + `gifski` for a tight GIF.
- **Stitch:** beat 1 → beat 2 → closing card into one ~20s GIF (or two short ones
  if a single GIF gets heavy). The README embeds it right under the hero.
- **Captions:** burn them in (the viewer often has sound off). Keep them to the
  one line per beat above.

## Why this demo (not buildwrightV2)

The QA run used buildwrightV2 (5,700 files, a 49 MB map) — great proof it works
at scale, terrible to *show*: nothing is legible in 6 seconds. This demo is the
opposite: small enough that every word on screen is readable, and the broken
guarantee (expired tokens) is one a viewer feels instantly. Scale is a benchmark
claim; legibility is the demo.
