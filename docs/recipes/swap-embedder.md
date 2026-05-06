# Recipe: plug in a custom embedding model

The semantic side of sivru's hybrid search is a single interface. If your
model can take text and return a fixed-dimension vector, it can drop in.

## The interface

`packages/search/src/embed/provider.ts`:

```ts
export type EmbeddingProvider = {
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch?(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery?(text: string): Promise<Float32Array>;   // for instruct embedders
};
```

**Vectors must be L2-normalized** — the hot path uses raw dot product as
cosine. A non-normalized vector silently breaks ranking.

`embedQuery` is optional. Define it only if your model uses different
prompt prefixes for queries vs documents (BGE, Nomic, E5). For symmetric
encoders (sentence-transformers, jina-code, Model2Vec) leave it out and
the engine uses `embed` for both.

## Three providers ship in-tree as references

| Path | Use it for |
|---|---|
| `packages/search/src/embed/mock.ts` | Tests. Deterministic SHA-256 → vector. No network, no model load. |
| `packages/search/src/embed/transformers.ts` | `@huggingface/transformers` — any HF model that supports `feature-extraction`. |
| `packages/search/src/embed/potion.ts` | Model2Vec static embedder (`minishlab/potion-retrieval-32M`) — default. ~1000× faster cold-start than transformers; modest quality hit. |
| `packages/search/src/embed/http.ts` | OpenAI / Voyage / Ollama / vLLM / LM Studio — any service that speaks `{ url, model, dim }`. |

Read `mock.ts` first if you want the smallest possible reference.

## Add a new provider

```ts
// packages/search/src/embed/my-provider.ts

import type { EmbeddingProvider } from "./provider.js";

export type MyProviderOptions = {
  apiKey: string;
  model?: string;
};

export function createMyProvider(opts: MyProviderOptions): EmbeddingProvider {
  const dim = 768; // whatever your model produces

  async function embed(text: string): Promise<Float32Array> {
    // 1. Call your model — return raw floats however you get them.
    const raw = await callMyModel(text, opts);
    // 2. L2-normalize. Skip this and ranking breaks silently.
    return l2Normalize(raw);
  }

  return {
    dim,
    embed,
    // Optional: implement embedBatch if your model accepts batches —
    // the engine will use it for ~10× throughput on cold-start indexing.
    async embedBatch(texts) {
      const rawBatch = await callMyModelBatched(texts, opts);
      return rawBatch.map(l2Normalize);
    },
  };
}

function l2Normalize(v: Float32Array | number[]): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}
```

## Asymmetric (instruct) embedders

If your model is BGE / Nomic / E5 or anything else with different prompt
prefixes for queries and documents, add `embedQuery` and let the engine
route the query side through it:

```ts
return {
  dim,
  async embed(text) {
    return l2Normalize(await callMyModel("search_document: " + text));
  },
  async embedQuery(text) {
    return l2Normalize(await callMyModel("search_query: " + text));
  },
};
```

The built-in Transformers.js provider already does this for known
instruct models — see `packages/search/src/embed/instructions.ts` for
the prefix lookup. Add a row there if your model is widely used.

## Wire it in

Re-export the factory from `packages/search/src/embed/index.ts`:

```ts
export { createMyProvider } from "./my-provider.js";
export type { MyProviderOptions } from "./my-provider.js";
```

Register your model in `packages/cli/src/lib/model-catalog.ts` so users
can pick it by short name (`sivru search --embed=my-model`,
`sivru config set embedder my-model`). Same pattern as the existing
`potion` / `minilm` / `bge-small` entries.

## Use it from the engine

```ts
import { buildIndex, createMyProvider } from "@sivrujs/search";

const idx = await buildIndex("./repo", {
  embed: { provider: createMyProvider({ apiKey: process.env.MY_API_KEY }) },
});
```

That's it. The vector pipeline doesn't care which model produced the floats
as long as the contract holds.

## Test it

A provider test should cover three things:

1. `dim` matches what you actually emit.
2. `embed("")` returns a vector of length `dim`. Empty strings happen — handle them.
3. The result is L2-normalized to within `1e-6`.

Reference: `packages/search/src/embed/transformers.test.ts`.

## What to think about

- **Cost.** A network embedder pays per chunk on every cold-start build.
  The on-disk cache (`packages/search/src/cache/`) saves embeddings once
  computed, but the first build of a 50k-chunk repo with a paid API can
  burn through quota fast. Consider rate-limiting + a chunk-size cap.
- **Determinism.** If your provider is non-deterministic (rare, but some
  hosted models are), it'll break the cache rehydration check. The cache
  hashes embeddings — different vectors for the same chunk will look like
  cache miss. Document this if it applies.
- **Privacy.** A provider that talks to a remote service routes user code
  to that service. The default `potion` provider stays fully local. If
  yours doesn't, surface that clearly in the factory's docstring.
- **Dimension.** 384, 768, 1536 are common. The engine handles any `dim ≥ 1`,
  but cosine top-K cost scales linearly with `dim`. Bigger isn't free.

Got a model that doesn't fit this shape? File an issue with `dx_feedback`
and what's awkward about it. The interface is small on purpose; we'd
rather expand it intentionally than grow it ad-hoc.
