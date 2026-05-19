#!/usr/bin/env node
// §5 efficacy smoke harness (DESIGN-0003 §5). Runs the routing-prompt corpus
// through the `claude` CLI and scores routing *correctness* — did the agent
// pick the tool that matches each prompt's query shape?
//
// This is NOT a unit test and is deliberately wired OUT of `pnpm test` / CI:
// it makes live `claude` calls (network, tokens, time). Run it by hand:
//
//   sivru skill install
//   pnpm --filter @sivru/cli smoke -- --label with-guidance
//   sivru skill uninstall
//   pnpm --filter @sivru/cli smoke -- --label without-guidance
//
// Compare the two correctness rates and record the result in CHANGELOG.md.
//
// FEASIBILITY (DESIGN-0003 §5): this harness is research-shaped. Before
// trusting any number, confirm `claude --output-format stream-json` emits
// the event schema src/smoke/parser.ts assumes. If it does not, fix the
// parser (and its fixture) — do not quietly downgrade §5 to eyeballing.

import { execFileSync } from "node:child_process";

import { ROUTING_CORPUS } from "./corpus.js";
import { firstRoutingChoice, parseToolUses, type ToolChoice } from "./parser.js";

function parseLabel(argv: readonly string[]): string {
  const i = argv.indexOf("--label");
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1] as string;
  return "unlabelled";
}

function claudeAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Drive one prompt through `claude` and return its raw stream-json output. */
function runPrompt(prompt: string): string {
  return execFileSync(
    "claude",
    ["-p", prompt, "--output-format", "stream-json", "--verbose"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
}

async function main(): Promise<number> {
  const label = parseLabel(process.argv.slice(2));

  if (!claudeAvailable()) {
    process.stderr.write(
      "smoke: the `claude` CLI was not found on PATH — the §5 harness " +
        "cannot run. (DESIGN-0003 §5: harness feasibility must be verified " +
        "before §5 can be reported.)\n",
    );
    return 1;
  }

  process.stdout.write(`§5 routing smoke test — label: ${label}\n\n`);

  let correct = 0;
  for (const item of ROUTING_CORPUS) {
    let choice: ToolChoice;
    try {
      choice = firstRoutingChoice(parseToolUses(runPrompt(item.prompt)));
    } catch (err) {
      process.stderr.write(
        `  ${item.id}: claude run failed: ${(err as Error).message}\n`,
      );
      choice = "none";
    }
    const ok = choice === item.expected;
    if (ok) correct++;
    process.stdout.write(
      `  ${ok ? "OK  " : "MISS"} ${item.id} ` +
        `(${item.shape}) expected=${item.expected} got=${choice}\n`,
    );
  }

  const total = ROUTING_CORPUS.length;
  const pct = total === 0 ? 0 : Math.round((correct / total) * 100);
  process.stdout.write(
    `\nrouting correctness: ${correct}/${total} (${pct}%) — label ${label}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`smoke: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  },
);
