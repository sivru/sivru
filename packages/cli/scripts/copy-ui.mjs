// Copy the built observe-ui static assets into the CLI's dist/ui/ so the
// published @sivru/cli tarball ships a self-contained UI. `sivru observe`
// resolves the UI from its own dist/ui first, with a monorepo fallback for
// dev. cli's build script runs observe-ui's `pnpm build` before this, so
// the source must exist — hard-fail if it doesn't.

import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));
const src = join(repoRoot, "packages", "observe-ui", "dist");
const dest = join(pkgRoot, "dist", "ui");

if (!existsSync(join(src, "index.html"))) {
  console.error(`copy-ui: observe-ui dist not built at ${src}`);
  console.error(`copy-ui: run \`pnpm --filter @sivru/observe-ui build\` first`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
console.log(`copy-ui: observe-ui dist → packages/cli/dist/ui/`);
