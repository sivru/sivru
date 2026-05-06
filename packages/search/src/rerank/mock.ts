// Deterministic mock cross-encoder for tests. Scores documents by
// (1) substring overlap with the query (favors literal matches) and
// (2) inverse document length (favors compact answers). The exact
// formula is irrelevant; what tests care about is that the score is
// deterministic and orders documents predictably without needing to
// download a real reranker model.

import type { CrossEncoder } from "./provider.js";

export type MockCrossEncoderOptions = {
  /** Diagnostic id. Default `"mock-cross-encoder"`. */
  modelId?: string;
};

export function createMockCrossEncoder(
  options?: MockCrossEncoderOptions,
): CrossEncoder {
  const modelId = options?.modelId ?? "mock-cross-encoder";
  return {
    modelId,
    async score(
      query: string,
      documents: readonly string[],
    ): Promise<number[]> {
      const q = query.toLowerCase();
      return documents.map((doc) => {
        const d = doc.toLowerCase();
        let overlap = 0;
        // Bag-of-words overlap, deduped against the query tokens.
        const seen = new Set<string>();
        for (const t of q.split(/[^a-z0-9_]+/).filter(Boolean)) {
          if (seen.has(t)) continue;
          seen.add(t);
          if (d.includes(t)) overlap += 1;
        }
        // Length penalty: compact docs score slightly higher per
        // overlap unit, roughly mimicking the "specific match" bias
        // real cross-encoders learn from MS-MARCO-style training.
        const lengthPenalty = 1 / Math.log2(Math.max(8, doc.length));
        return overlap * 10 + lengthPenalty;
      });
    },
  };
}
