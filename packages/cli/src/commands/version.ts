// `sivru version` — print the CLI version and exit 0.
//
// The version constant is exported for reuse by the help banner and any
// future telemetry / diagnostics surface.

export const SIVRU_VERSION = "0.1.0";

export async function runVersion(_argv: readonly string[]): Promise<number> {
  process.stdout.write(`sivru ${SIVRU_VERSION}\n`);
  return 0;
}
