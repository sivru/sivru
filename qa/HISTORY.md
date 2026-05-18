# QA history

Newest first. One entry per QA session — see `qa/README.md`.

## 2026-05-18 — v0.2.0 tree-sitter chunker

**Scope:** first QA of the tree-sitter chunker (DESIGN-0001), all 5
supported languages.

**Corpus:** zod (TS), requests (Python), gson (Java), chalk (JS),
uuid (Go) — 722 files walked, 11,762 chunks produced.

**Harness result:** `QA PASS` — 0 hard-invariant violations, 0 parse
failures. Full line coverage, content fidelity, valid ranges, and
kind/nodeType consistency held on every chunk. Symbol coverage 100%
of AST chunks.

**Bug found + fixed:** the harness initially flagged a whitespace-only
`.nojekyll` file as uncovered, and reported a misleading "fallback"
rate. Both were harness bugs, not chunker bugs — the coverage check
now mirrors the chunker's whitespace guard, and parse failures are
measured directly via `treeSitterChunks` rather than inferred from
chunk kinds (a covered file with no functions legitimately yields only
line chunks). `treeSitterChunks` / `isChunkableLanguage` were exported
from `@sivru/search` so the harness can probe parse success directly.

**CLI dogfood:** `sivru index` + `sivru search` on the Go and JS
corpora returned function-boundary results pointing at real
definitions.

**Verdict:** chunker is sound on real-world code across all 5
languages.
