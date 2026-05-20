// Resolves and reads the bundled `SKILL.md` — the canonical sivru routing
// policy that `sivru skill install` writes into a Claude Code skills
// directory.
//
// The asset is a static file shipped at the package root (`packages/cli/
// SKILL.md`), listed in `package.json` "files". This module is the single
// place that knows the path depth, so callers never hand-roll it.
//
//   layout (dev + published package are identical here):
//     packages/cli/SKILL.md          <- the asset
//     packages/cli/src/skill-asset.ts  -> dist/skill-asset.js
//
//   Both `src/` and `dist/` are direct children of the package root, so
//   `<thisFileDir>/../SKILL.md` resolves correctly whether this module is
//   running as TS source under vitest or as compiled JS from `dist/`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Frontmatter `name:` value the installed skill must carry. Used to tell a
 *  pristine/edited sivru skill apart from an unrelated file at the path. */
export const SKILL_FRONTMATTER_NAME = "sivru";

/** Absolute path to the bundled `SKILL.md` asset. */
export function resolveSkillAssetPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "SKILL.md");
}

/**
 * Read the bundled `SKILL.md`. Throws a clear, actionable error if the asset
 * is missing — that means the published package omitted it (a packaging bug),
 * never a user error.
 */
export function readBundledSkill(): string {
  const path = resolveSkillAssetPath();
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `bundled SKILL.md not found at ${path} — the @sivru/cli install is ` +
          `corrupt; reinstall it (npm install -g @sivru/cli)`,
      );
    }
    throw err;
  }
}

/**
 * Does `content` look like a sivru skill file? Checks the YAML frontmatter
 * for `name: sivru`. Used so a re-install never adopts or overwrites an
 * unrelated file that happens to sit at the target path.
 */
export function looksLikeSivruSkill(content: string): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  const frontmatter = match[1] ?? "";
  return /^name:\s*["']?sivru["']?\s*$/m.test(frontmatter);
}
