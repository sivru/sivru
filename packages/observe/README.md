# @sivrujs/observe

**Local-only session observability for Claude Code.** Reads
`~/.claude/projects/<cwd>/<uuid>.jsonl`, normalizes events to a stable
shape, exposes a localhost Hono HTTP server, and ships a token + dollar
savings estimator + offline counterfactual replay.

The observability layer behind [sivru](https://github.com/sivru/sivru);
usable standalone if you want to read your own Claude Code sessions
programmatically.

## Install

```bash
npm install @sivrujs/observe
```

## Privacy boundary

This package **MUST NOT** make network calls. Enforced by:

- A static lint rule blocking `fetch`, `node:http`, `node:https`, `node:net` imports.
- A runtime test that spies on `fetch` and fails if any code path tries to use it.

No telemetry, ever, default-on. If we ever add opt-in analytics, they'll
ship in a separate `sivru-analytics` package the user adds explicitly.

## Quick start

```ts
import { listSessions, readSession, createObserveApp } from "@sivrujs/observe";

// List all Claude Code sessions on disk.
const sessions = await listSessions();

// Stream events from one session.
for await (const event of readSession(sessions[0].path)) {
  console.log(event.kind, event.text?.slice(0, 80));
}

// Or run the HTTP server (see packages/cli for the full sivru observe binary).
const app = createObserveApp();
// ... serve via @hono/node-server
```

## What this is built for

Sessions, replay, costs, and bench tabs in the
[observe-ui](https://github.com/sivru/sivru) dashboard. Full docs:

- Repo: https://github.com/sivru/sivru
- Architecture: [ARCHITECTURE.md](https://github.com/sivru/sivru/blob/main/ARCHITECTURE.md)
- Why this exists: [WHY-SIVRU.md](https://github.com/sivru/sivru/blob/main/WHY-SIVRU.md)

## License

MIT
