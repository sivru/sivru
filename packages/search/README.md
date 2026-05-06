# @sivrujs/search

**Hybrid code search engine.** Gitignore-aware walker → code-aware
chunker → BM25 + cosine + RRF → optional cross-encoder rerank.
Pluggable embedding providers with asymmetric query encoding for
instruct embedders (BGE / Nomic / E5). On-disk cache.

The engine behind [sivru](https://github.com/sivru/sivru); usable
standalone as a TypeScript library.

## Install

```bash
npm install @sivrujs/search
```

## Quick start

```ts
import { buildIndex, createPotionProvider } from "@sivrujs/search";

const idx = await buildIndex("./repo", {
  embed: { provider: createPotionProvider() },
  cache: true,
});

const hits = await idx.searchHybrid("how does auth work end-to-end", 10);
for (const h of hits) {
  console.log(`${h.chunk.filePath}:${h.chunk.startLine}-${h.chunk.endLine}  ${h.score}`);
}
```

## Embedding providers

Three ship in-tree:

```ts
import {
  createPotionProvider,           // Model2Vec, default — no transformer inference
  createTransformersProvider,     // @huggingface/transformers, any HF model
  createHttpEmbeddingProvider,    // OpenAI / Voyage / Ollama / vLLM / LM Studio
} from "@sivrujs/search";
```

`EmbeddingProvider` is two methods (`{ dim, embed }` plus optional
`embedBatch` and `embedQuery`). Drop in your own model in ~30 lines —
recipe at https://github.com/sivru/sivru/blob/main/docs/recipes/swap-embedder.md.

## Cross-encoder rerank

```ts
import {
  buildIndex,
  createTransformersCrossEncoder,
} from "@sivrujs/search";

const idx = await buildIndex("./repo", {
  embed: { provider: createPotionProvider() },
  rerank: {
    provider: createTransformersCrossEncoder({
      model: "Xenova/ms-marco-MiniLM-L-6-v2",
    }),
    topN: 50,
  },
});
```

## What this is built for

A code search engine the LLM can reach through MCP, designed to fill the
gap where agentic grep+read burns tokens — natural-language queries,
behavioral queries, common-token noise, renamed code. See
[WHY-SIVRU.md](https://github.com/sivru/sivru/blob/main/WHY-SIVRU.md) for
the honest case for and against.

## Full docs

- Repo: https://github.com/sivru/sivru
- Architecture: [ARCHITECTURE.md](https://github.com/sivru/sivru/blob/main/ARCHITECTURE.md)
- Recipes: [docs/recipes/](https://github.com/sivru/sivru/tree/main/docs/recipes)

## License

MIT
