// `sivru version` — print the CLI version and exit 0.
//
// The version constant is exported for reuse by the help banner and any
// future telemetry / diagnostics surface. It is read from this package's
// own package.json (dist/commands/version.js → ../../package.json, and the
// same path holds for src/commands/version.ts under vitest) so it can never
// drift from the published version the way a hardcoded literal did.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
    "utf8",
  ),
) as { version: string };

export const SIVRU_VERSION = pkg.version;

export async function runVersion(_argv: readonly string[]): Promise<number> {
  process.stdout.write(`sivru ${SIVRU_VERSION}\n`);
  return 0;
}
