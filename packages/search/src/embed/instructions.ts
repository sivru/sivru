// Model-specific instruction / prompt prefixes for asymmetric embedders.
//
// Why this exists: instruct embedders like BGE, Nomic, and E5 train an
// asymmetric encoder where queries and documents take different prompt
// prefixes. Without the right prefix, the query is encoded as a
// document — which lands it in the wrong region of the vector space
// and tanks recall by 5–15% on standard retrieval benchmarks. The
// prefix is part of the contract; it isn't optional polish.
//
// Symmetric providers (sentence-transformers/all-MiniLM-L6-v2,
// jina-embeddings-v2-base-code, potion/Model2Vec) don't use prefixes;
// the helper returns empty strings for them.
//
// References:
//   BGE:   https://huggingface.co/BAAI/bge-small-en-v1.5
//          "for retrieval task, we recommend to add instruction for query"
//   Nomic: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
//          "search_query: " / "search_document: " role tags
//   E5:    https://huggingface.co/intfloat/e5-small-v2
//          "query: " / "passage: " role tags

export type InstructionPrefixes = {
  /** Prefix prepended to the query before encoding. May be empty. */
  query: string;
  /** Prefix prepended to documents (chunks) before encoding. May be empty. */
  document: string;
};

const NONE: InstructionPrefixes = { query: "", document: "" };

const BGE_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

/**
 * Look up the right (queryPrefix, documentPrefix) pair for a Hugging
 * Face model id. The match is case-insensitive on the model id (so
 * `Xenova/bge-small-en-v1.5` and `BAAI/bge-small-en-v1.5` both hit).
 *
 * Unknown models return empty prefixes — symmetric encoding with no
 * prefix is the safe default that doesn't make existing models worse.
 */
export function instructionPrefixesFor(modelId: string): InstructionPrefixes {
  const m = modelId.toLowerCase();

  // Nomic v1 / v1.5 — explicit role tags. Other Nomic variants
  // (e.g. nomic-bert-2048) don't use them, but those aren't supported
  // by Transformers.js feature-extraction anyway.
  if (m.includes("nomic-embed-text")) {
    return {
      query: "search_query: ",
      document: "search_document: ",
    };
  }

  // BGE retrieval line. Per the model card the document side does NOT
  // take a prefix; only the query does.
  // The bge-m3 multi-vector / bge-reranker variants are NOT covered
  // here — they need different orchestration than feature-extraction.
  if (
    /(^|\/)bge-(small|base|large)-en/.test(m) ||
    /(^|\/)bge-(small|base|large)-zh/.test(m) ||
    /(^|\/)bge-(small|base|large)-en-v1\.5/.test(m)
  ) {
    return { query: BGE_QUERY_PREFIX, document: "" };
  }

  // E5 family — symmetric prompt tags. Covers e5-small/base/large,
  // multilingual-e5, e5-mistral.
  if (/(^|\/)(multilingual-)?e5-/.test(m)) {
    return { query: "query: ", document: "passage: " };
  }

  return NONE;
}
