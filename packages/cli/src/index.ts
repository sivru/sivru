#!/usr/bin/env node
// sivru CLI binary entry. Dispatches argv[2] to a command module under
// `./commands/`, plus the MCP server entry. Each command module exports a
// `runX(argv): Promise<number>` returning the process exit code.

import {
  runBenchModels,
  runBenchPersonal,
  runBlock,
  runCheckupCmd,
  runConfig,
  runDoctor,
  runExplain,
  runFeedback,
  runFromGit,
  runHelp,
  runIndex,
  runMap,
  runObserve,
  runSearch,
  runSession,
  runSkill,
  runVersion,
} from "./commands/index.js";
import { runMcp } from "./mcp-entry.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";

  switch (cmd) {
    case "version":
    case "--version":
    case "-v":
      return runVersion(argv);

    case "search":
      return runSearch(argv);

    case "index":
      return runIndex(argv);

    case "mcp":
      return runMcp(argv);

    case "from-git":
      return runFromGit(argv);

    case "session":
      return runSession(argv);

    case "observe":
      return runObserve(argv);

    case "doctor":
      return runDoctor(argv);

    case "bench":
      // bench subcommands. `tthw` (Time-To-Helpful-Window) is queued; the
      // other two ship today.
      if (argv[1] === "personal") return runBenchPersonal(argv.slice(1));
      if (argv[1] === "models") return runBenchModels(argv.slice(1));
      process.stderr.write(
        `sivru bench: missing or unknown subcommand. Available:\n` +
          `  sivru bench personal     — run sivru against YOUR sessions + repos\n` +
          `  sivru bench models       — list registered embedding models with metadata\n`,
      );
      return 2;

    case "config":
      return runConfig(argv);

    case "skill":
      return runSkill(argv);

    case "explain":
      return runExplain(argv.slice(1));

    case "map":
      return runMap(argv.slice(1));

    case "feedback":
      return runFeedback(argv.slice(1));

    case "block":
      return runBlock(argv.slice(1));

    case "checkup":
      return runCheckupCmd(argv.slice(1));

    case "help":
    case "--help":
    case "-h":
      return runHelp(argv);

    case "find-related":
    case "cache":
    case "model":
    case "completion":
      process.stderr.write(
        `sivru ${cmd} — not yet implemented; tracked on https://github.com/sivru/sivru\n`,
      );
      return 2;

    default:
      process.stderr.write(`sivru: unknown command "${cmd}"\n\n`);
      await runHelp(argv);
      return 2;
  }
}

// Setting process.exitCode (instead of calling process.exit) lets Node's
// runtime exit naturally after stdout/stderr have drained. Calling
// process.exit on a piped stdout truncates the write at the OS pipe-
// buffer boundary (~8 KiB on macOS), silently corrupting `block extract
// --json` and any other large stdout consumer downstream — including
// the v0.6 CI role-coverage gate that parses the extract output.
function exitWhenDrained(code: number): void {
  process.exitCode = code;
  // process.stdout is unref'd by default; nothing else holds the loop
  // open, so Node exits as soon as the write buffer is flushed.
}

main().then(
  (code) => exitWhenDrained(code),
  (err: unknown) => {
    process.stderr.write(`sivru: ${(err as Error).message ?? String(err)}\n`);
    exitWhenDrained(1);
  },
);
