// Barrel for the CLI command modules. The top-level dispatcher in
// `../index.ts` imports `runX` from here and routes argv[0] to the right
// handler. Keep this file zero-logic — just re-exports + the shared
// `Command` union for the dispatcher's switch.

export { runVersion, SIVRU_VERSION } from "./version.js";
export { runHelp } from "./help.js";
export { runSearch } from "./search.js";
export { runIndex } from "./index-cmd.js";
export { runFromGit } from "./from-git.js";
export { runSession } from "./session.js";
export { runObserve } from "./observe.js";
export { runDoctor } from "./doctor.js";
export { runBenchPersonal } from "./bench-personal.js";
export { runBenchModels } from "./bench-models.js";
export { runConfig } from "./config.js";

export type Command =
  | "search"
  | "index"
  | "mcp"
  | "from-git"
  | "session"
  | "observe"
  | "doctor"
  | "bench"
  | "config"
  | "version"
  | "help";
