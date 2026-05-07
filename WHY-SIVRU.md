# Why does sivru exist?

Anthropic's Claude Code team explicitly chose **not** to use RAG /
vector search for code. Boris Cherny, Claude Code's lead, said it
plainly: "early versions of Claude Code used RAG + a local vector db,
but we found pretty quickly that agentic search generally works
better." If Anthropic looked at this and said no, why is sivru saying
yes?

Short answer: **sivru isn't competing with agentic search. It's a
tool the agent calls when agentic search is the wrong shape for the
question.**

> **A note on terminology.** When this doc says "RAG" it means the
> contested usage from the Anthropic-vs-RAG debate: *indexed
> retrieval* — embeddings, vector lookups, chunking, top-k.
> Strictly, sivru is the retrieval component; the generation happens
> in the agent. The full system (sivru + Claude Code) is
> retrieval-augmented generation. Calling sivru itself "RAG" is
> loose, but it matches how the term is used in this conversation.

## The case for agentic search

Anthropic's reasoning is correct, and we don't argue with it:

1. **Code is exact-match-shaped.** `createD1HttpClient` either appears
   in a file or it doesn't. Vector similarity that surfaces
   "conceptually adjacent" symbols introduces noise in a context
   where exactness is what matters.
2. **Freshness.** `grep` reads the current filesystem. Pre-built
   indexes drift during active editing.
3. **Privacy.** No embedding pipeline means no data leaves the
   machine and no provider needs to see proprietary code.
4. **Simplicity.** No index, no chunker, no embedder, no rerank.
   Zero setup.
5. **Iterative refinement.** The agent can grep → read → refine →
   grep again. Single-shot retrieval can't do that.
6. **It just worked better in their tests.** Anthropic's framing:
   "agentic search outperformed [RAG] by a lot, and this was
   surprising."

For most queries on most repos, this is the right answer. We use
Claude Code with `Grep` and `Read` every day and it works.

## Where agentic search legitimately struggles

There are real query shapes where grep + read is a bad fit:

1. **Natural-language / behavioral queries.** "How does authentication
   actually work end-to-end?" doesn't map to a keyword. The agent has
   to guess at one, grep, fail, re-guess. Each round costs tokens.
2. **Common-token noise.** Searching `useState` in a React monorepo
   returns hundreds of hits. The agent reads or filters — both
   expensive.
3. **Renamed code.** A function got renamed three releases ago. `grep`
   finds nothing. An embedding-based retriever still finds it via
   semantic proximity.
4. **Large monorepos.** Iterative grep can burn context faster than
   it narrows, especially on cross-cutting questions.
5. **Concept-shaped queries.** "Where do we sign requests" doesn't
   map cleanly to a single identifier.

These aren't theoretical — they're the queries where Claude Code
spends multiple turns and many thousands of tokens before landing on
the right file.

## How sivru is built differently

Sivru is RAG, but not naive RAG. Most of the criticism aimed at RAG
is aimed at first-generation RAG (vector-only retrieval over
arbitrary chunks, stale indexes, no rerank). Each criticism has a
known answer; sivru implements them:

| Criticism | What sivru does |
|---|---|
| Vector noise on exact identifiers | **Hybrid retrieval** — BM25 lexical + cosine semantic, fused via RRF. Exact identifiers still rank correctly via the BM25 side. |
| Stale indexes | `refreshStale()` re-walks the corpus and re-embeds only modified files. The MCP server calls it before every search. |
| Privacy / data leaves machine | All local. Default embedder is Model2Vec (a static lookup table, no inference). Transformer embedders run locally via `@huggingface/transformers`. `packages/observe/` is statically banned from network calls. |
| Naive chunk boundaries lose context | 50-line line-fallback today; tree-sitter function-boundary chunks queued for v0.2. |
| Conceptual-adjacency noise | Optional cross-encoder reranker scores the top-50 candidates with a model that sees query + document jointly, not via independent embedding. |
| Mis-tuned embedders | Asymmetric query encoding for BGE / Nomic / E5. Without the right prompt prefix those models retrieve at sub-optimal capacity (5–15% recall hit). |
| "We don't know if it's actually worth it" | `sivru bench personal` runs the IR-correct comparison on YOUR sessions and YOUR repos. Recall@5 / MRR / tokens-saved with bootstrap 90% CIs. |

We also ship public quality gates so we don't fool ourselves: NDCG@10
on a 60-query labeled corpus, agent-task token economy against a
`ripgrep + Read` baseline, a perf gate that fails CI on >15%
regression. All raw data committed.

## When to use sivru

Reach for sivru when:

- The query is natural-language or behavioral ("how does X work").
- The repo is large and grep loops are burning context.
- You want to ablate retrieval quality vs. tokens-saved on YOUR data
  before deciding what to turn on.

Stick with `Grep` + `Read` when:

- The query is identifier-shaped (`Foo.bar`, `useState`).
- The repo is small enough that `ripgrep` returns a tractable result.
- You don't want any extra setup.

The MCP integration supports both. `sivru.search` is one tool the
agent can call; the agent can still call `Grep` and `Read` whenever
it wants. **They're complementary, not exclusive.**

## Local-first AND extensible-by-default

Every feature with a registry, ruleset, or catalog follows three layers:

1. **Built-in defaults** for out-of-the-box use.
2. **Declarative JSON override** at `~/.config/sivru/<feature>.json`
   (user-global) and `.sivru/<feature>.json` (per-project). No code
   needed for common tweaks.
3. **Code-level extension** at `.sivru/<feature>/*.ts` for the cases the
   JSON can't express.

Today this applies to embedders (`bm25`, `potion`, `minilm`, `bge-small`,
`jina-code`, `nomic-embed` built in; any HuggingFace model via
`hf:owner/model`; user-defined providers via the `EmbeddingProvider`
interface) and rerankers (`ms-marco-minilm`, `bge-reranker-base`, plus
`hf:owner/model`). The same pattern applies to every new feature on the
roadmap (failure-mode detection rules, memory-audit checks, skill
recommendations) — see [ROADMAP.md](ROADMAP.md).

You can swap any layer without forking sivru.

## What we don't claim

- We don't claim RAG is better than agentic search. It isn't, on
  average.
- We don't claim Anthropic was wrong to choose agentic search. They
  weren't.
- We don't have evidence that sivru wins on the "average query" —
  and we explicitly tell users to bench on their own data before
  trusting any number we publish.

The case for sivru is narrower: there's a real class of query that
agentic search handles poorly, and that class is the case for a
careful, hybrid, locally-run retrieval layer that the agent can opt
into when the question shape calls for it.

## Further reading

- [Building Claude Code with Boris Cherny](https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny)
  — Pragmatic Engineer interview covering Claude Code's design.
- [Claude Code Doesn't Index Your Codebase. Here's What It Does Instead.](https://vadim.blog/claude-code-no-indexing)
  — direct quotes from the Claude Code team on the agentic-search choice.
- [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
  — Anthropic's broader framing on agent design choices.
- [Why I'm Against Claude Code's Grep-Only Retrieval](https://milvus.io/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens.md)
  — the counter-position; argues grep burns too many tokens on large
  repos.
- [On the Lost Nuance of Grep vs. Semantic Search](https://www.nuss-and-bolts.com/p/on-the-lost-nuance-of-grep-vs-semantic)
  — a nuanced take that frames the two as complementary, not
  competing.
