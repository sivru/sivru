#!/usr/bin/env node
// §5 efficacy smoke harness (DESIGN-0003 §5). Runs the routing-prompt corpus
// through the `claude` CLI and scores routing *correctness* — did the agent
// pick the tool that matches each prompt's query shape?
//
// This is NOT a unit test and is deliberately wired OUT of `pnpm test` / CI:
// it makes live `claude` calls (network, tokens, time). Run it by hand:
//
//   sivru skill install
//   pnpm --filter @sivru/cli smoke -- --label with-guidance --repeat 3
//   sivru skill uninstall
//   pnpm --filter @sivru/cli smoke -- --label without-guidance --repeat 3
//
// Compare the two correctness rates and record the result in CHANGELOG.md.
//
// FLAGS
//   --label <name>   tag for the report line (e.g. with-guidance)
//   --repeat N       run every prompt N times and score over all trials.
//                    A single n=15 run is noisy; N>=3 is the trustworthy
//                    setting (DESIGN-0003 §5 measured result, finding 2).
//   --no-delegate    block the Task/Agent sub-agent tools. Headless
//                    `claude` delegates a codebase search to a sub-agent
//                    that does not carry the sivru skill — so a plain run
//                    measures delegation, not the skill. --no-delegate
//                    isolates the skill's own routing effect.
//
// HARNESS NOTES (verified against claude 2.1.144, 2026-05-19):
//   - Tool use in headless `claude -p` is gated; the run passes
//     --allowedTools or the agent calls no tools.
//   - `claude` exits NON-ZERO on --max-turns, but the stream-json is
//     still complete; the harness reads output regardless of exit code.
//   - A genuine launch failure (zero output) is retried once per trial.

import { spawnSync } from "node:child_process";

import { ROUTING_CORPUS } from "./corpus.js";
import { firstRoutingChoice, parseToolUses } from "./parser.js";

type Options = { label: string; repeat: number; noDelegate: boolean };

function parseOptions(argv: readonly string[]): Options {
  let label = "unlabelled";
  let repeat = 1;
  let noDelegate = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label" && argv[i + 1] !== undefined) {
      label = argv[++i] as string;
    } else if (arg === "--repeat" && argv[i + 1] !== undefined) {
      const n = Number.parseInt(argv[++i] as string, 10);
      if (Number.isFinite(n) && n > 0) repeat = n;
    } else if (arg === "--no-delegate") {
      noDelegate = true;
    }
  }
  return { label, repeat, noDelegate };
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
 * and whether the harness `ran` it. A non-zero exit (e.g. error_max_turns)
 * is not a failure — the output is still complete. `ran` is false only when
 * `claude` could not launch or produced nothing parseable.
 */
function runPrompt(prompt: string, noDelegate: boolean): PromptRun {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "6",
    "--allowedTools",
    ...SMOKE_ALLOWED_TOOLS,
  ];
  if (noDelegate) {
    // Block sub-agent delegation so the main agent — the one that reads
    // the skill — makes the routing decision itself.
    args.push("--disallowedTools", "Task", "Agent");
  }
  const res = spawnSync("claude", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { output: "", ran: false };
  const output = res.stdout ?? "";
  return { output, ran: output.trim().length > 0 };
}

async function main(): Promise<number> {
  const opts = parseOptions(process.argv.slice(2));

  if (!claudeAvailable()) {
    process.stderr.write(
      "smoke: the `claude` CLI was not found on PATH — the §5 harness " +
        "cannot run.\n",
    );
    return 1;
  }

  process.stdout.write(
    `§5 routing smoke test — label: ${opts.label}` +
      ` | repeat: ${opts.repeat}` +
      `${opts.noDelegate ? " | no-delegate" : ""}\n\n`,
  );

  let correctTrials = 0;
  let totalTrials = 0;
  let erroredTrials = 0;
  for (const item of ROUTING_CORPUS) {
    let promptCorrect = 0;
    let promptScored = 0;
    let promptErrored = 0;
    for (let t = 0; t < opts.repeat; t++) {
      let run = runPrompt(item.prompt, opts.noDelegate);
      if (!run.ran) run = runPrompt(item.prompt, opts.noDelegate); // one retry
      if (!run.ran) {
        promptErrored++;
        erroredTrials++;
        continue;
      }
      const choice = firstRoutingChoice(parseToolUses(run.output));
      promptScored++;
      totalTrials++;
      if (choice === item.expected) {
        promptCorrect++;
        correctTrials++;
      }
    }
    const tag =
      promptScored === 0
        ? "ERR "
        : promptCorrect === promptScored
          ? "OK  "
          : promptCorrect === 0
            ? "MISS"
            : "~   ";
    process.stdout.write(
      `  ${tag} ${item.id} (${item.shape}) ` +
        `${promptCorrect}/${promptScored} → ${item.expected}` +
        `${promptErrored > 0 ? ` [${promptErrored} errored]` : ""}\n`,
    );
  }

  const pct = totalTrials === 0 ? 0 : Math.round((correctTrials / totalTrials) * 100);
  process.stdout.write(
    `\nrouting correctness: ${correctTrials}/${totalTrials} trials ` +
      `(${pct}%) — label ${opts.label}` +
      `${opts.noDelegate ? " (no-delegate)" : ""}\n`,
  );
  if (erroredTrials > 0) {
    process.stdout.write(
      `(${erroredTrials} trial(s) errored and were excluded)\n`,
    );
  }

  const attempted = totalTrials + erroredTrials;
  if (totalTrials === 0 || erroredTrials / attempted > 0.25) {
    process.stderr.write(
      `\n${erroredTrials}/${attempted} trials errored — too many to trust ` +
        `this run. Treat it as a harness failure, not a routing result.\n`,
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
