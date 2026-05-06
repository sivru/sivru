#!/usr/bin/env node
// sivru CLI binary entry. Dispatches argv[2] to a command module under
// `./commands/`, plus the MCP server entry. Each command module exports a
// `runX(argv): Promise<number>` returning the process exit code.

import {
  runBenchModels,
  runBenchPersonal,
  runConfig,
  runDoctor,
  runFromGit,
  runHelp,
  runIndex,
  runObserve,
  runSearch,
  runSession,
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

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`sivru: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  },
);
