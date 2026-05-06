// `sivru index <path>` — walk + chunk + BM25-index `path` (default `.`) and
// print summary stats. Lightweight: no embeddings, no querying.
//
// `--json` emits a single JSON line for machine consumption.

import { stat } from "node:fs/promises";

import { buildIndex } from "@sivrujs/search";

type ParsedArgs = {
  path: string;
  json: boolean;
};

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  let json = false;
  const positional: string[] = [];

  // Skip argv[0] which is the command name itself.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  const path = positional[0] ?? ".";
  return { path, json };
}

export async function runIndex(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru index: ${parsed.error}\n`);
    return 1;
  }

  const { path, json } = parsed;

  try {
    const st = await stat(path);
    if (!st.isDirectory() && !st.isFile()) {
      process.stderr.write(`sivru index: not a file or directory: ${path}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`sivru index: path does not exist: ${path}\n`);
    return 1;
  }

  const startedAt = Date.now();
  const index = await buildIndex(path, { cache: true });
  const ms = Date.now() - startedAt;
  const chunks = index.size();
  const cacheHit = index.cacheHit;

  if (json) {
    process.stdout.write(JSON.stringify({ path, chunks, ms, cacheHit }) + "\n");
    return 0;
  }

  process.stdout.write(
    [
      `indexed ${path}${cacheHit ? " (cache hit)" : ""}`,
      `  chunks: ${chunks}`,
      `  took:   ${ms} ms`,
    ].join("\n") + "\n",
  );
  return 0;
}
