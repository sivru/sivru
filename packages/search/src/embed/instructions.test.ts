import { describe, expect, it } from "vitest";

import { instructionPrefixesFor } from "./instructions.js";

describe("instructionPrefixesFor", () => {
  it("returns empty prefixes for symmetric encoders", () => {
    expect(instructionPrefixesFor("Xenova/all-MiniLM-L6-v2")).toEqual({
      query: "",
      document: "",
    });
    expect(
      instructionPrefixesFor("Xenova/jina-embeddings-v2-base-code"),
    ).toEqual({ query: "", document: "" });
    expect(instructionPrefixesFor("minishlab/potion-retrieval-32M")).toEqual({
      query: "",
      document: "",
    });
  });

  it("returns asymmetric query/doc tags for nomic-embed-text variants", () => {
    const v1 = instructionPrefixesFor("nomic-ai/nomic-embed-text-v1");
    const v15 = instructionPrefixesFor("Xenova/nomic-embed-text-v1.5");
    expect(v1.query).toBe("search_query: ");
    expect(v1.document).toBe("search_document: ");
    expect(v15).toEqual(v1);
  });

  it("returns the BGE retrieval-instruction prefix for bge-* retrieval models", () => {
    const small = instructionPrefixesFor("BAAI/bge-small-en-v1.5");
    expect(small.query).toMatch(/^Represent this sentence for searching/);
    expect(small.document).toBe("");
    // Variants under different namespaces resolve the same way.
    expect(instructionPrefixesFor("Xenova/bge-base-en-v1.5").query).toBe(
      small.query,
    );
    expect(instructionPrefixesFor("BAAI/bge-large-en").query).toBe(small.query);
  });

  it("returns query:/passage: tags for E5 models", () => {
    expect(instructionPrefixesFor("intfloat/e5-small-v2")).toEqual({
      query: "query: ",
      document: "passage: ",
    });
    expect(instructionPrefixesFor("intfloat/multilingual-e5-base")).toEqual({
      query: "query: ",
      document: "passage: ",
    });
  });

  it("is case-insensitive on the model id", () => {
    expect(instructionPrefixesFor("BAAI/BGE-Small-EN-v1.5").query).toMatch(
      /^Represent this sentence/,
    );
    expect(instructionPrefixesFor("NOMIC-AI/Nomic-Embed-Text-v1.5").query).toBe(
      "search_query: ",
    );
  });

  it("returns empty prefixes for unrecognized models", () => {
    expect(instructionPrefixesFor("acme/some-new-embedder")).toEqual({
      query: "",
      document: "",
    });
  });
});
