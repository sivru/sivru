// Shared `execFile` wrapper (DESIGN-0005 A3).
//
// Pattern extracted to be reused by `git-stats.ts` here in the coach
// module. `packages/cli/src/commands/doctor.ts` keeps its own private
// helper for now; the doctor.ts refactor lands in a follow-up so the
// duplication never sticks (tracked in the slice's out-of-scope list).
//
// PRIVACY (DESIGN-0005 §2 / DESIGN.md §5.5): `node:child_process` is
// not on the banned-imports list in `egress.test.ts` (only http/https/
// net/tls/undici/fetch are). Shelling out to `git` is local IO.

import { execFile } from "node:child_process";

export interface ExecOk {
  ok: true;
  /** stdout decoded as utf-8. */
  stdout: string;
}

export interface ExecErr {
  ok: false;
  /**
   * Coarse failure reason. The caller cares whether the binary was
   * missing (so the check can fall back) vs. a non-zero exit (which
   * may mean a per-file issue worth retrying).
   */
  reason: "missing" | "non-zero" | "timeout";
  stderr: string;
}

export type ExecResult = ExecOk | ExecErr;

export interface ExecOptions {
  /** Working directory for the child. Default: inherited. */
  cwd?: string;
  /** Soft timeout in milliseconds. Default 4000ms (doctor.ts precedent). */
  timeoutMs?: number;
}

/**
 * Run `cmd args` and resolve with a discriminated result. Never throws.
 *
 * - Binary not on PATH → `{ ok: false, reason: "missing" }`
 * - Non-zero exit → `{ ok: false, reason: "non-zero" }`
 * - Timeout fires → `{ ok: false, reason: "timeout" }`
 * - Success → `{ ok: true, stdout }`
 */
export function runCmd(
  cmd: string,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  return new Promise((resolveFn) => {
    let settled = false;
    const settle = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      resolveFn(r);
    };

    const child = execFile(
      cmd,
      args.slice(),
      {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const so = typeof stdout === "string" ? stdout : "";
        const se = typeof stderr === "string" ? stderr : "";
        if (err === null) {
          settle({ ok: true, stdout: so });
          return;
        }
        const e = err as NodeJS.ErrnoException & {
          signal?: string | null;
          killed?: boolean;
        };
        // ENOENT — binary missing from PATH.
        if (e.code === "ENOENT") {
          settle({ ok: false, reason: "missing", stderr: se });
          return;
        }
        // Killed by timeout — Node sets `killed:true` and signals SIGTERM
        // when the `timeout` option fires.
        if (e.killed === true) {
          settle({ ok: false, reason: "timeout", stderr: se });
          return;
        }
        settle({ ok: false, reason: "non-zero", stderr: se });
      },
    );
    child.on("error", (err) => {
      // ENOENT — binary missing from PATH. Any other spawn-time error
      // we lump in here too (rare; same caller treatment).
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        settle({ ok: false, reason: "missing", stderr: "" });
      } else {
        settle({ ok: false, reason: "non-zero", stderr: String(e.message) });
      }
    });
  });
}
