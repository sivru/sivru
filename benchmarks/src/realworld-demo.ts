// One-off real-world bench runner. Drives the same `runAgentTasks` engine
// the labeled corpus uses, but against a repo that lives outside
// `benchmarks/corpus/`. Invoked manually to produce a snapshot for
// `BENCHMARKS.md` — not part of `pnpm bench:agent`, not gated by CI.
//
// Usage:
//   pnpm --filter @sivru/benchmarks tsx src/realworld-demo.ts \
//     --repo /path/to/checkout \
//     --name vitest \
//     --root packages/vitest/src
//
// The script ships with a default query set for a TypeScript repo. To run
// on another language, pass `--queries path/to/queries.json` whose contents
// are an array of `{ query: string }` objects.

import { writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex } from "@sivru/search";
import type { SivruIndex } from "@sivru/search";

import { runAgentTasks, formatAgentTaskReport } from "./agent-tasks.js";
import type { Annotation, RepoSpec, RetrievalResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// Reasonable defaults for a TypeScript repo. Override with --queries path.
const DEFAULT_QUERIES_TS: string[] = [
  "how does the test runner discover test files",
  "where is the snapshot serializer implemented",
  "how does vi.mock work under the hood",
  "what is the entry point for the CLI",
  "where is the watch mode implemented",
  "how does the worker pool spawn isolated test contexts",
  "where is concurrent test scheduling handled",
  "how does the reporter API work",
  "where is the coverage adapter for v8 implemented",
  "how are test.each tables parsed and expanded",
];

type Args = {
  repo: string;
  name: string;
  root: string;
  outFile: string;
  queries: string[];
};

function parseArgs(argv: readonly string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} expects a value`);
      return v;
    };
    if (a === "--repo") args.repo = next();
    else if (a === "--name") args.name = next();
    else if (a === "--root") args.root = next();
    else if (a === "--out") args.outFile = next();
  }
  if (args.repo === undefined) {
    throw new Error("--repo <path> is required");
  }
  args.name ??= basename(args.repo);
  args.root ??= ".";
  args.outFile ??= resolve(ROOT, "benchmarks", `realworld-${args.name}.json`);
  return {
    repo: args.repo,
    name: args.name,
    root: args.root,
    outFile: args.outFile,
    queries: DEFAULT_QUERIES_TS,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  process.stderr.write(
    `realworld-demo: indexing ${args.repo}/${args.root} (name=${args.name})...\n`,
  );

  // Wire the agent-tasks runner to a single synthetic repo that points at
  // wherever the user's checkout actually lives. corpusDir is the parent
  // of the checkout; repos[0].name is the directory inside it.
  const corpusParent = dirname(args.repo);
  const repoDirName = basename(args.repo);

  const repoSpec: RepoSpec = {
    name: repoDirName,
    language: "typescript",
    url: "n/a",
    revision: "HEAD",
    benchmark_root: args.root,
  };

  // Build the index once and share it across all queries via a closure.
  const benchRoot = resolve(args.repo, args.root);
  const t0 = performance.now();
  const index: SivruIndex = await buildIndex(benchRoot, { cache: true });
  const t1 = performance.now();
  process.stderr.write(
    `realworld-demo: indexed ${index.size()} chunks in ${Math.round(t1 - t0)} ms\n`,
  );

  const annotations: Annotation[] = args.queries.map((q) => ({
    query: q,
    relevant: [],
    secondary: [],
    category: "realworld",
  }));

  const adapter = async (
    _repo: RepoSpec,
    query: string,
    topK: number,
  ): Promise<RetrievalResult[]> => {
    const hits = await index.searchBM25(query, topK);
    return hits.map((hit) => ({
      filePath:
        args.root === "" || args.root === "."
          ? hit.chunk.filePath
          : `${args.root.replace(/\/+$/, "")}/${hit.chunk.filePath}`,
      startLine: hit.chunk.startLine,
      endLine: hit.chunk.endLine,
      score: hit.score,
    }));
  };

  const report = await runAgentTasks(
    adapter,
    `sivru-bm25-realworld-${args.name}`,
    [repoSpec],
    () => annotations,
    { corpusDir: corpusParent, n: args.queries.length },
  );

  process.stdout.write(formatAgentTaskReport(report) + "\n");

  writeFileSync(args.outFile, JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(`realworld-demo: wrote ${args.outFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`realworld-demo failed: ${(err as Error).message}\n`);
  if ((err as Error).stack !== undefined) {
    process.stderr.write((err as Error).stack + "\n");
  }
  process.exit(1);
});
