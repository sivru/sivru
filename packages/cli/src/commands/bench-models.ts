// `sivru bench models` — list every embedding model the CLI knows
// about, with size / RAM / cold-start estimates. Pre-flight reading
// before deciding which one to benchmark with `sivru bench personal`.

import { listModels, listRerankers } from "../lib/model-catalog.js";

export async function runBenchModels(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  const entries = listModels();
  const rerankers = listRerankers();

  if (json) {
    process.stdout.write(
      JSON.stringify({ embedders: entries, rerankers }, null, 2) + "\n",
    );
    return 0;
  }

  // Text table. Two-line layout per model — top row with the headline
  // numbers, second row with the recommendation copy. Easier to read
  // than a single wide table that wraps.
  const lines: string[] = [];
  lines.push(
    "Embedding models registered with sivru. Numbers are estimates from",
  );
  lines.push(
    "commodity hardware; bench locally with `sivru bench personal --models <name>` for your machine.",
  );
  lines.push("");
  for (const entry of entries) {
    const m = entry.metadata;
    lines.push(`  ${entry.shortName}  —  ${m.label}`);
    if (entry.kind === "bm25") {
      lines.push(
        `    no embedding model · n/a dim · 0 MB disk · 0 MB RAM · cold-start <1s`,
      );
    } else {
      lines.push(
        `    ${m.params} params · ${m.dim} dim · ${m.contextTokens} ctx · ${m.diskMB} MB disk · ${m.ramIdleMB}–${m.ramPeakEmbedMB} MB RAM`,
      );
      lines.push(
        `    ~${m.approxMsPerChunkCpu} ms/chunk CPU · ~${m.approxColdStartMin} min cold-start (16k chunks) · ${m.license}${m.codeOptimized ? " · code-tuned" : ""}`,
      );
    }
    lines.push(`    ${m.recommended}`);
    lines.push(`    ${m.url}`);
    lines.push("");
  }
  lines.push("Cross-encoder rerankers (apply to top-50 candidates after retrieval):");
  lines.push("");
  for (const r of rerankers) {
    const m = r.metadata;
    lines.push(`  ${r.shortName}  —  ${m.label}`);
    lines.push(
      `    ${m.params} params · ${m.diskMB} MB disk · ~${m.approxMsPerQueryAt50} ms / 50 pairs CPU · ${m.license}`,
    );
    lines.push(`    ${m.recommended}`);
    lines.push(`    ${m.url}`);
    lines.push("");
  }

  lines.push("To set the default embedder for `sivru search` + the MCP server:");
  lines.push("  sivru config set embedder <name>");
  lines.push("");
  lines.push("To benchmark on your own sessions + repos:");
  lines.push("  sivru bench personal --models bm25,potion,jina-code");
  lines.push("");
  lines.push("To layer a cross-encoder reranker on top:");
  lines.push("  sivru bench personal --models potion --rerank=ms-marco-minilm");
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return 0;
}
