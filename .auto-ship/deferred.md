# Deferred findings from auto-ship runs

Findings recorded here are minor/nit-level items surfaced by /code-review that the
loop chose to ship as-is. Each entry: run journal path, file:line, finding, date.

## Run: .auto-ship/runs/20260521-222604-sivru-annotation-blocks.md (DESIGN-0016 v0.6.0) — 2026-05-21

- packages/search/src/block/extract.ts:69-74 — `makeFenceEndRegex` rebuilt per line inside the hot loop; cache once per opened fence.
- packages/search/src/block/extract.ts:115 — regex permits no extra leading whitespace before prefix on `@end`; inconsistent indent inside a body fires SIVRU-E215 instead of relaxing.
- packages/search/src/block/extract.ts:353-355 — dead `if` block (comment only, no behavior).
- packages/search/src/block/extract.ts:596-614 — TS/TSX/JS/JSX module-locator branch duplicates the Python branch verbatim; extract a helper.
- packages/search/src/block/module-locators/python.ts:90-93 + typescript.ts:94 — unreachable `void filePath` lines after `return`.
- packages/cli/src/commands/block.ts:104-110 — skip-path matches any `/__fixtures__/` substring; a real source dir containing that name would be silently excluded (low risk; worth a comment).
- .github/workflows/ci.yml:64-81 — CI role-coverage gate uses `execSync` with default `maxBuffer` (1 MB); pass `{ maxBuffer: 64 * 1024 * 1024 }` for headroom.
- packages/search/src/block/validate.ts:118-125 — re-checks E212 here even though extract.ts:393-402 already short-circuits; defensive, but a hand-called validateBlock on a runaway block would emit two E212 diagnostics.
- packages/cli/src/commands/block.test.ts:27 — double mkdir call in mkRepo helper (redundant).
