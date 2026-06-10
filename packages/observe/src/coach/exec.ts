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
  /**
   * Run through the platform shell. Default off — keep it off for any call
   * that passes file-path args (a path with spaces is mis-quoted under a
   * shell). Opt in ONLY to resolve a launcher binary on Windows, where a tool
   * like `pnpm` is really `pnpm.cmd` and bare `execFile` cannot find it.
   */
  shell?: boolean;
}

/**
 * Tokens allowed when `shell: true`: letters, digits, and the punctuation that
 * appears in launcher names, flags, and paths (`. _ - / \ : =`). Anything else
 * (spaces, quotes, `; & | $ ( ) < > \` * ?` …) is rejected, which keeps shell
 * mode usable only for fixed-arg launcher probes — never an injection vector.
 */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9._:=/\\-]+$/;

/**
 * Run `cmd args` and resolve with a discriminated result. The returned
 * promise never rejects on command failure:
 *
 * - Binary not on PATH → `{ ok: false, reason: "missing" }`
 * - Non-zero exit → `{ ok: false, reason: "non-zero" }`
 * - Timeout fires → `{ ok: false, reason: "timeout" }`
 * - Success → `{ ok: true, stdout }`
 *
 * It throws synchronously in exactly one case — a programming guard: `shell:
 * true` combined with an argument that carries shell metacharacters. Shell
 * mode exists only to resolve a launcher binary on Windows; it must never be
 * handed caller- or path-derived data, so we fail loud rather than let it
 * become a command-injection vector.
 */
export function runCmd(
  cmd: string,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  if (opts.shell) {
    for (const token of [cmd, ...args]) {
      if (!SHELL_SAFE_TOKEN.test(token)) {
        throw new Error(
          `runCmd: shell:true rejects ${JSON.stringify(token)} — it contains ` +
            `characters unsafe under a shell. shell mode is for launcher ` +
            `resolution (e.g. pnpm.cmd) with simple, fixed args only.`,
        );
      }
    }
  }
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
        ...(opts.shell ? { shell: true } : {}),
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
