// Copy the bundled tree-sitter grammar WASM from src into dist after `tsc`.
//
// tsc only emits .js/.d.ts; the grammar .wasm files are committed binary
// assets (DESIGN-0001 D2 — bundled, not downloaded). The published package
// ships `dist/`, so the chunker resolves grammars from `dist/chunker/
// grammars/` at runtime. `fs.cpSync` keeps this cross-platform — CI runs
// the Windows leg of the matrix.

import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(pkgRoot, "src", "chunker", "grammars");
const dest = join(pkgRoot, "dist", "chunker", "grammars");

if (!existsSync(src)) {
  console.error(`copy-grammars: source dir missing: ${src}`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });

const wasm = readdirSync(dest).filter((f) => f.endsWith(".wasm"));
if (wasm.length === 0) {
  console.error(`copy-grammars: no .wasm copied into ${dest}`);
  process.exit(1);
}
console.log(`copy-grammars: ${wasm.length} grammar(s) → dist/chunker/grammars/`);
