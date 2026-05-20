# The routing testbench

This directory is the §5 efficacy testbench for the sivru skill
(DESIGN-0003 §5). It answers one question with data instead of vibes:
**does the routing guidance make the agent pick the right tool?**

## What's here

- `corpus.ts` — the labelled examples. Each `RoutingPrompt` is a real
  prompt plus its query shape and the tool a correctly routed agent
  should reach for.
- `parser.ts` — extracts the tools an agent used from `claude`
  stream-json output.
- `runner.ts` — drives the corpus through the `claude` CLI and scores
  routing correctness. Not a unit test; makes live `claude` calls.
- `parser.test.ts`, `corpus.test.ts` — unit tests. These DO run in CI.

## Query shapes and correct routing

| Shape | The prompt looks like | Correct tool |
|-------|----------------------|--------------|
| `behavioural` | natural-language "how/where does X work" | `sivru.search` |
| `identifier` | an exact known token, string, or symbol | `grep` |
| `after-edit` | "I changed file:lines, what's affected" | `sivru.find_related` |

Success is *correctness* — picking the tool that matches the shape.
A behavioural query routed to grep is wrong; an identifier query routed
to `sivru.search` is also wrong. The test never rewards "used sivru
more."

## Running it

```bash
pnpm --filter @sivru/cli build

sivru skill install
pnpm --filter @sivru/cli smoke -- --label with-guidance --repeat 3 --no-delegate
sivru skill uninstall
pnpm --filter @sivru/cli smoke -- --label without-guidance --repeat 3 --no-delegate
```

Compare the two correctness rates. The gap is the skill's efficacy.
Record the numbers in `CHANGELOG.md`.

### Flags

- `--repeat N` — run every prompt N times, score over all trials. A
  single n=15 run is noisy (LLM non-determinism shuffles a prompt or
  two); `N>=3` is the trustworthy setting.
- `--no-delegate` — block the Task/Agent sub-agent tools. **Use this
  for any efficacy measurement.** Headless `claude` delegates a
  codebase search to a sub-agent that runs in its own context and does
  *not* carry the sivru skill — so a plain run measures delegation, not
  the skill. A traced behavioural prompt with delegation on greps; the
  same prompt with `--no-delegate` loads the skill and routes to
  `sivru.search`. Without this flag the testbench understates the
  skill (DESIGN-0003 §5, measured-result finding 2).

### Two things the runner needs, both learned the hard way

- The sivru MCP server `claude` talks to must be **this repo's build**,
  not a stale global install — otherwise the run silently tests old
  tool descriptions. Register it with
  `claude mcp add sivru -s user -- node <repo>/packages/cli/dist/index.js mcp`.
- Run each label with `--repeat 3` or more. One run's gap is
  directional, not precise. This is the seam the v0.16 bench closes.

## Keep enhancing it — this is a living testbench

A testbench that never grows stops catching things. When you touch
routing, the skill body, or the MCP tool descriptions, **add cases**:

1. Add a `RoutingPrompt` to the right section of `corpus.ts`. Pick a
   stable `id`, write a realistic `prompt`, set `shape` and `expected`
   (must match the shape — `corpus.test.ts` enforces it).
2. Favour cases that have bitten before: ambiguous prompts, prompts
   that name a symbol inside a natural-language question, large-repo
   phrasings, renamed-symbol queries.
3. When a real session shows a misroute, turn it into a corpus entry
   so it can't regress silently.
4. `corpus.test.ts` guards a minimum per shape — the bench can grow,
   never quietly shrink. As it grows, raise `MIN_PER_SHAPE`.

The v0.16 skill-efficacy bench is the formal successor to this corpus.
Everything added here seeds it.
