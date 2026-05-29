// Shared path-safety primitives for the observe HTTP server.
//
// Single source of truth for the containment rule used by every route that
// accepts a caller-supplied path (`/api/checkup`, `/api/blocks*`): a path is
// allowed only if it is an existing absolute location under the user's homedir
// OR inside a git working tree. Keeping this in one module means a future
// tightening (e.g. closing a traversal edge, handling a Windows UNC case) lands
// for all routes at once instead of drifting between hand-rolled copies.
//
// PRIVACY NOTE (DESIGN.md §5.5): this file imports only node:path/os and the
// local git probe (a child-process shell-out, not network). No outbound calls.

import { homedir } from "node:os";
import { normalize, sep } from "node:path";

import { probeGit } from "../coach/git-stats.js";

/** Platform-native absolute path check (POSIX `/…`, Windows `C:\…`). */
export function isAbsolutePathStrict(p: string): boolean {
  if (process.platform === "win32") return /^[a-zA-Z]:[\\/]/.test(p);
  return p.startsWith("/");
}

/** True when `child` is `parent` or sits under it, at a path-segment boundary. */
export function isUnder(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  const pTrim = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(pTrim);
}

export interface Containment {
  allowed: boolean;
  /** True when the git binary is missing, so the check ran homedir-only. */
  degraded: boolean;
}

/**
 * Containment decision for an absolute path: allowed if under homedir OR inside
 * a git working tree. When git is unavailable the check degrades to homedir-only
 * and reports `degraded: true` so the caller can surface SIVRU-E244.
 *
 * Run this BEFORE any `stat`, so probing a path outside the surface does not
 * leak whether it exists.
 */
export async function pathContainment(abs: string): Promise<Containment> {
  if (isUnder(abs, homedir())) return { allowed: true, degraded: false };
  const probe = await probeGit(abs);
  if (probe.available) return { allowed: true, degraded: false };
  return { allowed: false, degraded: probe.reason === "missing" };
}
