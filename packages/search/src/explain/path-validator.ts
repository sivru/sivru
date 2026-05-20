// Threat-model path validator (DESIGN-0004 §6 / T13).
//
// Two layers of safety on user-supplied `<path>` arguments:
//   1. syntactic — reject absolute paths and `..` escapes before anything
//      reaches the filesystem
//   2. realpath — resolve the path and assert the resolved location stays
//      inside the resolved repo root (catches symlinks pointing outside)
//
// `parsePathAndSymbol` parses the `<path>::<symbol>` CLI form. The `::`
// separator never appears in a legitimate POSIX filename, so the parse is
// unambiguous.

import { promises as fsp } from "node:fs";
import { isAbsolute, posix, resolve as resolvePath, sep } from "node:path";

import { SivruExplainError } from "./types.js";

/**
 * Parse the `<path>` or `<path>::<symbol>` CLI form.
 * The `::` separator is never legal in a filename; a single `:` may appear
 * in absolute Windows paths (`C:\...`) — that case is rejected by the
 * absolute-path check below, not here.
 */
export function parsePathAndSymbol(arg: string): {
  path: string;
  symbol: string | null;
} {
  const sep = arg.indexOf("::");
  if (sep === -1) return { path: arg, symbol: null };
  return { path: arg.slice(0, sep), symbol: arg.slice(sep + 2) };
}

/**
 * Syntactic check: reject absolute paths and `..` escapes. Run before any
 * filesystem call to keep the realpath layer cheap and the error message
 * specific.
 */
export function validateRelPathSyntax(relPath: string): void {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new SivruExplainError("SIVRU-E2001", "path must be a non-empty string");
  }
  if (isAbsolute(relPath)) {
    throw new SivruExplainError(
      "SIVRU-E2001",
      `path must be repo-relative, got absolute path "${relPath}"`,
    );
  }
  // Normalise to POSIX separators for the `..` segment check so this works on
  // Windows. Native `path.normalize` may eat valid `..` segments — we want to
  // see them.
  const posixed = relPath.split(sep).join(posix.sep);
  const segs = posixed.split(posix.sep);
  for (const s of segs) {
    if (s === "..") {
      throw new SivruExplainError(
        "SIVRU-E2001",
        `path contains a parent-directory segment ("..") which is not allowed: "${relPath}"`,
      );
    }
  }
}

/**
 * Resolve the user-supplied relative path against `repoRoot`, then realpath
 * both. Assert the resolved target stays inside the resolved repo root.
 * Throws SIVRU-E2002 on symlink escape, SIVRU-E2009 when the file is missing
 * but appears legal.
 *
 * Returns the resolved absolute path on success.
 */
export async function resolveAndAssertInside(
  relPath: string,
  repoRoot: string,
): Promise<string> {
  validateRelPathSyntax(relPath);
  const joinedAbs = resolvePath(repoRoot, relPath);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fsp.realpath(repoRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SivruExplainError(
      "SIVRU-E2009",
      `repoRoot does not exist or is not readable: ${message}`,
    );
  }
  try {
    realTarget = await fsp.realpath(joinedAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Path is syntactically OK and inside repoRoot; we just can't realpath
      // it because it doesn't exist (or a parent doesn't). Still need to
      // confirm it would have been inside before reporting "not found", so
      // do a string-prefix check on the joined absolute path.
      const rootSlash = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      const joinedSlash = joinedAbs.endsWith(sep) ? joinedAbs : joinedAbs + sep;
      if (!joinedSlash.startsWith(rootSlash) && joinedAbs !== realRoot) {
        throw new SivruExplainError(
          "SIVRU-E2009",
          `path "${relPath}" resolves outside the repo root`,
        );
      }
      throw new SivruExplainError(
        "SIVRU-E2009",
        `path "${relPath}" does not exist inside the repo`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new SivruExplainError(
      "SIVRU-E2002",
      `realpath failed for "${relPath}": ${message}`,
    );
  }
  // Resolved both sides; confirm the target is inside the repo root.
  const rootSlash = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  const targetSlash = realTarget.endsWith(sep) ? realTarget : realTarget + sep;
  if (realTarget === realRoot) return realTarget; // root itself
  if (!targetSlash.startsWith(rootSlash)) {
    throw new SivruExplainError(
      "SIVRU-E2002",
      `path "${relPath}" resolves outside repo root via symlink`,
    );
  }
  return realTarget;
}
