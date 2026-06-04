// The @sivru/observe package version, read from its own package.json
// (dist/version.js → ../package.json, and the same path holds for
// src/version.ts under vitest) so it can never drift from the published
// version the way a hardcoded literal did.
//
// PRIVACY NOTE (DESIGN.md §5.5): node:fs/url/path are local IO only — no
// network module is imported, so the egress boundary is unaffected.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
) as { version: string };

export const SIVRU_OBSERVE_VERSION = pkg.version;
