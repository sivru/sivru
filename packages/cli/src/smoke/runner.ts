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
// HARNESS NOTES (verified against claude 2.1.144, 2026-05-19):
//   - Tool use in headless `claude -p` is gated; the run must pass
//     --allowedTools or the agent calls no tools (every prompt -> none).
//   - `claude` exits NON-ZERO when it hits --max-turns, but the
//     stream-json is still complete and parseable. So the harness reads
//     the output regardless of exit code — the first routing tool is a
//     valid signal whether or not the agent finished the task.
//   - A genuine failure (claude can't launch, zero output) is retried
//     once, then excluded from the denominator.

import { spawnSync } from "node:child_process";

import { ROUTING_CORPUS } from "./corpus.js";
import { firstRoutingChoice, parseToolUses, type ToolChoice } from "./parser.js";

function parseLabel(argv: readonly string[]): string {
  const i = argv.indexOf("--label");
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1] as string;
  return "unlabelled";
}

function claudeAvailable(): boolean {
  const res = spawnSync("claude", ["--version"], { stdio: "ignore" });
  return !res.error && res.status === 0;
}

// The agent can only route to a tool it is allowed to call. In headless
// `claude -p` mode tool use is gated, so the harness passes an explicit
// allowlist — without it every prompt scores `none` and the test is dead.
const SMOKE_ALLOWED_TOOLS = [
  "Grep",
  "Read",
  "Glob",
  "mcp__sivru__search",
  "mcp__sivru__find_related",
];

type PromptRun = { output: string; ran: boolean };

/**
 * Drive one prompt through `claude`. Returns the raw stream-json `output`
 * and whether the harness `ran` it at all. A non-zero exit (e.g. `claude`'s
 * error_max_turns) is NOT a failure — the output is still complete and the
 * routing signal valid. `ran` is false only when `claude` could not launch
 * or produced nothing parseable.
 */
function runPrompt(prompt: string): PromptRun {
  const res = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "6",
      "--allowedTools",
      ...SMOKE_ALLOWED_TOOLS,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.error) return { output: "", ran: false };
  const output = res.stdout ?? "";
  return { output, ran: output.trim().length > 0 };
}

async function main(): Promise<number> {
  const label = parseLabel(process.argv.slice(2));

  if (!claudeAvailable()) {
    process.stderr.write(
      "smoke: the `claude` CLI was not found on PATH — the §5 harness " +
        "cannot run.\n",
    );
    return 1;
  }

  process.stdout.write(`§5 routing smoke test — label: ${label}\n\n`);

  let correct = 0;
  let errored = 0;
  for (const item of ROUTING_CORPUS) {
    // One retry covers a transient launch failure; a max-turns exit does
    // not reach here as a failure (runPrompt returns ran:true with output).
    let run = runPrompt(item.prompt);
    if (!run.ran) run = runPrompt(item.prompt);

    let choice: ToolChoice = "none";
    if (run.ran) {
      choice = firstRoutingChoice(parseToolUses(run.output));
    } else {
      errored++;
    }
    const ok = run.ran && choice === item.expected;
    if (ok) correct++;
    process.stdout.write(
      `  ${ok ? "OK  " : "MISS"} ${item.id} ` +
        `(${item.shape}) expected=${item.expected} got=${choice}` +
        `${run.ran ? "" : " [ERRORED]"}\n`,
    );
  }

  const total = ROUTING_CORPUS.length;
  const scored = total - errored;
  const pct = scored === 0 ? 0 : Math.round((correct / scored) * 100);
  process.stdout.write(
    `\nrouting correctness: ${correct}/${scored} scored (${pct}%) — label ${label}\n`,
  );
  if (errored > 0) {
    process.stdout.write(
      `(${errored}/${total} prompt(s) errored and were excluded)\n`,
    );
  }

  // Only call it a harness failure when too many prompts errored to trust
  // the number — a stray one or two is normal for live API calls.
  if (scored === 0 || errored / total > 0.25) {
    process.stderr.write(
      `\n${errored}/${total} errored — too many to trust this run. ` +
        `Treat it as a harness failure, not a routing result.\n`,
    );
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`smoke: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  },
);
