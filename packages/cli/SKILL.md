---
name: sivru
description: >-
  Use when searching or navigating a codebase — finding where something is
  implemented, understanding how a behaviour works end to end, or finding the
  code related to an edit. Covers when to reach for sivru's semantic search
  versus grep, and how to check callers and tests after changing a symbol.
---

# sivru — code search routing for coding agents

sivru is a local code-search tool exposed to you over MCP. It does not
replace grep. It is a second instrument, and this skill is the policy
for when to pick which one. It is written to be honest: there are query
shapes where grep is the better tool, and it says so.

## The instruments

- **grep / ripgrep** — exact, literal, current. Best when you already
  know the token you are looking for.
- **`sivru.search`** — hybrid lexical + semantic search over the repo.
  Best when the question is about behaviour or concept and you do not
  know the exact identifier yet.
- **`sivru.map`** — orient in the architecture around a target: its
  module + role, its 1-hop dependency neighbourhood (the blast radius),
  and its descriptive health (hot rank, dependency cycle, broken `@sivru`
  linkages). Best **before editing**, to frame the area.
- **`sivru.explain`** — public API, callers, callees, churn, ownership,
  and the `@sivru` intent for one file or symbol. Best **before editing**
  one symbol — to know who depends on what you are about to touch.

## The before-edit arc

For a change of any size the instruments compose in order — **search
finds, map orients, explain inspects**:

1. `sivru.search` — locate the file when you do not know where it is.
2. `sivru.map` — orient in the area: the module, the neighbours that
   break if you change the contract, and whether the spot is hot, in a
   cycle, or has drifted intent.
3. `sivru.explain` — inspect the one symbol you are about to change.
4. edit.
5. `sivru.find_related` — catch the callers/tests your change touched.

Skip steps you do not need (you often know the file already), but when
you are about to touch unfamiliar code, run the whole arc.

## When to reach for `sivru.search`

Use `sivru.search` when the query is **natural-language or
behavioural** — you are describing *what the code does*, not naming it:

- "where is auth refresh handled"
- "how does retry backoff work"
- "where do we sign outbound requests"
- a concept that does not map to one identifier ("rate limiting",
  "the onboarding flow")

Also reach for it when grep is fighting you: a common token returning
hundreds of hits, or a symbol that was renamed and the old name finds
nothing. Semantic search still locates renamed code.

## When to stick with grep

Use grep — it is faster and more precise — when the query is
**identifier-shaped**:

- an exact symbol you already know: `parseConfig`, `UserSession.refresh`
- finding every call site of a known function
- an exact string, error message, or import path
- the repo is small enough that ripgrep returns a tractable result

A semantic search for an exact identifier is the wrong tool. Do not
route an identifier query through `sivru.search` because this skill
mentions sivru — route by the shape of the question.

## Before you edit — orient first with `sivru.map`

When you are about to work in unfamiliar code, call `sivru.map` before
`sivru.explain`. Give it the file or symbol you are heading for:

- `sivru.map({ path: "src/foo.ts" })` — a file: the module/package slice
  (role, neighbours, health).
- `sivru.map({ path: "src/foo.ts::doThing" })` — a symbol (or pass a
  separate `symbol`).
- `sivru.map({ task: "where retry backoff is configured" })` — when you
  do not have a path yet: it returns ranked **candidate** targets. Pick
  one and map it; it never silently orients on a guess.

The slice tells you the blast radius (`dependsOn` / `dependedOnBy`) and
the descriptive health: a `hot` rank ("you are editing a top hot spot"),
`inCycle` ("this module is already in a cycle — don't deepen it"), and
`driftBroken` (an `@sivru` invariant whose test no longer resolves). Every
response carries a `kind` (`slice` / `candidates` / `error`) — branch on
it. An unresolved path comes back as `kind: "error"` with did-you-mean
`candidates`, not a dead end. `freshAsOf` tells you whether the slice
reflects your latest edit yet. `map` is descriptive — it reports current
state, never predicts what your edit will break (that is `explain
diff:true` and the PR gate).

## Before you edit a file — `sivru.explain`

When you are about to change a file or a symbol, call `sivru.explain` on
it first. It leads with **authored context** — the `@sivru` block on each
symbol (role, responsibility, invariants, time-bounded decisions) when one
exists — then the descriptive sections: public API, callers, callees,
churn, ownership, tests, and a **block-health** line flagging any lint on
the file's blocks. Read the authored context before anything else: it is
the intent — *why* the code is shaped this way, and when that reasoning
expires — that the derived facts cannot recover. Then use the caller list
to know what depends on what you are about to touch, the churn + ownership
to gauge how settled the code is, and the tests section to see what
already covers it. If `BLOCKS HEALTH` reports errors on a block you are
about to rely on, treat that block's intent as suspect, not authoritative.

Two extra shapes are worth knowing:

- `sivru.explain({ path: "src/foo.ts::doThing" })` — region-level. The
  artifact is sliced to one symbol's line range, with per-region churn
  via `git log -L`. Use when you only care about one function or method.
- `sivru.explain({ path: "src/foo.ts", diff: true })` — diff mode. Reads
  your in-progress working-tree edit, identifies removed exports, and
  for each one tells you which callers will break. Use mid-edit when you
  are deleting a symbol and want to know who calls it.

## After you edit a symbol — `sivru.find_related`

When you have changed a function, class, or a line range, call
`sivru.find_related` on it **before you consider the edit finished**.
It surfaces callers, tests, and similar code that your change may have
affected — the code you would otherwise have to remember to grep for.
This is the cheapest way to catch a change that compiled but broke a
caller or left a test stale.

## Authoring `@sivru` annotation blocks

If you are about to edit a symbol that does NOT yet carry an `@sivru`
block, and the change you are about to make depends on knowing the
symbol's intent / invariants / a past decision: BEFORE editing, write
the block. Author it from the existing code + git history + any
adjacent docs. This is the cheapest moment to record the WHY — you are
already reconstructing it.

The block lives inside the symbol's existing doc-comment carrier
(`/** */` for TS/JS/Java, `///` or `//` for Go, `"""..."""` docstring
for Python). Minimal valid form:

```
@sivru
schema: 1
role: <one-line role name, kebab-case>
responsibility: <one line: what this symbol is FOR>
@end
```

Optional fields when they earn their keep: `collaborators` (named
symbols it depends on or that depend on it), `invariants` (claims that
must hold which the type system does not enforce), `decisions[]`
(`chose` / `because` / `valid-while` / `revisit-if` — the four-field
form is what makes a decision durable), `maturity`
(`stable | experimental | deprecated | wip`).

Run `sivru block validate <path>` before committing. Errors block CI;
warnings (e.g. block-prose at >25 lines, decision-no-revisit) ship.

If you are about to edit a symbol that ALREADY carries an `@sivru`
block: READ it before editing — `sivru.explain` surfaces it as the
`AUTHORED CONTEXT` section, so the call you already make before an edit
hands you the intent for free. The block tells you the role the symbol
plays in the system and the decisions that shaped it — that context is
exactly what tests cannot recover. The rule: if your change alters the
symbol's contract or invalidates a decision, update its block in the
same edit — revise `responsibility` / `invariants`, update or remove the
stale decision's `revisit-if`. An edit that changes behaviour but leaves
the block asserting the old intent is worse than no block: it lies to the
next agent.

## sivru also observes sessions

`sivru observe` is a separate local tool that reads coding-session
history and reports what was searched, read, and edited. You do not
invoke it mid-task; it is mentioned here so you know the capability
exists if a user asks about session history or cost.

## Why this skill exists

sivru is the runtime — it ships the search index and the observe
tooling. This skill is the playbook — it tells you *when* to call
them. The two MCP tool descriptions carry a one-line version of this
policy; this file is the longer form. They say the same thing.
