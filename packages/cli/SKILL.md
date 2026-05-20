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

## The three instruments

- **grep / ripgrep** — exact, literal, current. Best when you already
  know the token you are looking for.
- **`sivru.search`** — hybrid lexical + semantic search over the repo.
  Best when the question is about behaviour or concept and you do not
  know the exact identifier yet.
- **`sivru.explain`** — public API, callers, callees, churn, ownership
  for one file or symbol. Best **before editing** — to know who depends
  on what you are about to touch.

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

## Before you edit a file — `sivru.explain`

When you are about to change a file or a symbol, call `sivru.explain` on
it first. It returns five descriptive sections — public API, callers,
callees, churn, ownership — for the target. Use the caller list to know
what depends on what you are about to touch, the churn + ownership to
gauge how settled the code is, and the tests section to see what already
covers it.

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
