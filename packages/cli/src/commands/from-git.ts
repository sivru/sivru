// `sivru from-git <url> [-r <ref>|--ref <ref>] [--allow-private-urls] [--json]`
//
// Clones a remote repo into `~/.cache/sivru/git/<sha256(url#ref)>/` (shallow,
// depth 1) and prints the local path so the user can `sivru search` against
// it. v1 surface is **CLI-only** — the MCP tool intentionally does not expose
// this command (DESIGN.md §4.5: arbitrary git URL fetching from an
// LLM-controlled tool is an SSRF surface we don't ship in v1).
//
// The default-on SSRF guard is a *string-pattern* check on the URL hostname.
// We deliberately do not resolve DNS — that's a v2 concern (DNS rebinding,
// AAAA→IPv4 fallthrough, etc. all require a more involved guard).
//
// Network is mockable via the `_internal.spawn` seam so tests don't actually
// shell out to `git`.
//
// `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + ESM-only
// (`module: NodeNext`) are all live in this package; that's why imports use
// `.js` and we avoid passing `undefined` for optional fields.

import { spawn as _spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";

// Test seam — vitest can override `_internal.spawn` to avoid network. The
// signature is intentionally narrower than `node:child_process`'s (which has
// many overloads); we only need the (command, args, options?) shape.
type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

const wrappedSpawn: SpawnFn = (command, args, options) =>
  options === undefined
    ? _spawn(command, args as string[])
    : _spawn(command, args as string[], options);

export const _internal: { spawn: SpawnFn } = { spawn: wrappedSpawn };

const ALLOWED_SCHEMES = new Set([
  "https:",
  "http:",
  "git:",
  "ssh:",
  "git+ssh:",
  "git+https:",
]);

type ParsedArgs = {
  url: string;
  ref: string | undefined;
  allowPrivate: boolean;
  json: boolean;
};

type ParseError = { error: string; exit: 1 | 2 };

function parseArgs(argv: readonly string[]): ParsedArgs | ParseError {
  let ref: string | undefined;
  let allowPrivate = false;
  let json = false;
  const positional: string[] = [];

  // Skip argv[0] which is the command name itself.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--json") {
      json = true;
    } else if (arg === "--allow-private-urls") {
      allowPrivate = true;
    } else if (arg === "--ref" || arg === "-r") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: `missing value for ${arg}`, exit: 1 };
      }
      ref = next;
      i++;
    } else if (arg.startsWith("--ref=")) {
      ref = arg.slice("--ref=".length);
    } else if (arg.startsWith("--") || arg.startsWith("-")) {
      // Unknown flag → exit 2.
      return { error: `unknown flag: ${arg}`, exit: 2 };
    } else {
      positional.push(arg);
    }
  }

  const url = positional[0];
  if (url === undefined || url.length === 0) {
    return {
      error: "missing url\nusage: sivru from-git <url> [-r <ref>] [--allow-private-urls] [--json]",
      exit: 1,
    };
  }

  const parsed: ParsedArgs = { url, ref, allowPrivate, json };
  return parsed;
}

type SsrfResult = { ok: true } | { ok: false; reason: string };

// String-pattern SSRF guard. NOT a substitute for a real DNS-aware check, but
// catches the obvious cases an unsuspecting user might paste: localhost,
// loopback literals, RFC 1918 ranges, link-local. Bad schemes are always
// rejected, even with --allow-private-urls.
export function checkSsrf(rawUrl: string, allowPrivate: boolean): SsrfResult {
  // SCP-style git URLs (`git@host:path`) are not parseable by `URL` but are
  // common in the wild. We accept them as "ssh-like" and only check the host
  // segment.
  const scpMatch = /^([^\s@]+)@([^:]+):(.+)$/.exec(rawUrl);
  let scheme: string;
  let hostname: string;
  if (scpMatch) {
    scheme = "ssh:";
    hostname = scpMatch[2] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, reason: `invalid url: ${rawUrl}` };
    }
    scheme = parsed.protocol;
    hostname = parsed.hostname;
  }

  if (!ALLOWED_SCHEMES.has(scheme)) {
    return {
      ok: false,
      reason: `disallowed scheme '${scheme}' (allowed: https, http, git, ssh, git+ssh, git+https)`,
    };
  }

  if (allowPrivate) {
    return { ok: true };
  }

  // Strip IPv6 brackets. `URL.hostname` does this for us, but the SCP-form
  // path doesn't go through URL parsing.
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  if (host === "localhost" || host === "0.0.0.0" || host === "::1") {
    return { ok: false, reason: `private host '${host}' (use --allow-private-urls to override)` };
  }

  // 127.0.0.0/8 — any 127.x.y.z literal.
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || host === "127.0.0.1") {
    return { ok: false, reason: `private host '${host}' (use --allow-private-urls to override)` };
  }

  // 10.x.y.z
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) {
    return { ok: false, reason: `private host '${host}' (use --allow-private-urls to override)` };
  }

  // 192.168.x.y
  if (/^192\.168\.\d+\.\d+$/.test(host)) {
    return { ok: false, reason: `private host '${host}' (use --allow-private-urls to override)` };
  }

  // 172.16.0.0/12 — second octet 16..31.
  const m172 = /^172\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m172) {
    const second = Number.parseInt(m172[1] ?? "0", 10);
    if (second >= 16 && second <= 31) {
      return { ok: false, reason: `private host '${host}' (use --allow-private-urls to override)` };
    }
  }

  // 169.254.x.y — link-local.
  if (/^169\.254\.\d+\.\d+$/.test(host)) {
    return { ok: false, reason: `link-local host '${host}' (use --allow-private-urls to override)` };
  }

  return { ok: true };
}

function cacheDirFor(url: string, ref: string | undefined): string {
  const hash = createHash("sha256");
  hash.update(url + "#" + (ref ?? "HEAD"));
  return join(homedir(), ".cache", "sivru", "git", hash.digest("hex"));
}

type RunResult = { code: number; stdout: string; stderr: string };

function runGit(args: readonly string[], options: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = _internal.spawn("git", args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += typeof d === "string" ? d : d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : d.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Read HEAD sha from a `.git` directory without shelling out — used as a
// fallback when stub-spawn doesn't implement `rev-parse`. Returns undefined
// if HEAD is unreadable.
async function readHeadFromDotGit(dotGit: string): Promise<string | undefined> {
  try {
    const headRaw = (await readFile(join(dotGit, "HEAD"), "utf8")).trim();
    // Either a 40-char sha directly, or `ref: refs/heads/<branch>`.
    if (/^[0-9a-f]{40}$/.test(headRaw)) {
      return headRaw;
    }
    const m = /^ref:\s+(.+)$/.exec(headRaw);
    if (m) {
      const refPath = m[1];
      if (refPath !== undefined) {
        const refContents = (await readFile(join(dotGit, refPath), "utf8")).trim();
        if (/^[0-9a-f]{40}$/.test(refContents)) {
          return refContents;
        }
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}

export async function runFromGit(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`sivru from-git: ${parsed.error}\n`);
    return parsed.exit;
  }

  const { url, ref, allowPrivate, json } = parsed;

  const ssrf = checkSsrf(url, allowPrivate);
  if (!ssrf.ok) {
    process.stderr.write(`sivru from-git: ${ssrf.reason}\n`);
    return 1;
  }

  const dir = cacheDirFor(url, ref);
  const dotGit = join(dir, ".git");

  let cached = false;
  if (await pathExists(dotGit)) {
    // Try `git -C <dir> rev-parse HEAD`. If it succeeds we treat it as
    // cached; otherwise wipe and re-clone.
    const head = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    if (head.code === 0 && head.stdout.trim().length > 0) {
      cached = true;
    } else {
      await rm(dir, { recursive: true, force: true });
    }
  }

  let headSha: string | undefined;

  if (cached) {
    const head = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    if (head.code === 0 && head.stdout.trim().length > 0) {
      headSha = head.stdout.trim();
    } else {
      headSha = await readHeadFromDotGit(dotGit);
    }
  } else {
    await mkdir(dirname(dir), { recursive: true });

    const cloneArgs = ["clone", "--depth", "1"];
    if (ref !== undefined) {
      cloneArgs.push("--branch", ref);
    }
    cloneArgs.push("--", url, dir);

    // Stream child stderr to our stderr so the user sees progress / errors.
    const child = _internal.spawn("git", cloneArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let cloneStderr = "";
    child.stdout?.on("data", () => {
      // discard
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      const chunk = typeof d === "string" ? d : d.toString("utf8");
      cloneStderr += chunk;
      process.stderr.write(chunk);
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", (err) => reject(err));
      child.on("close", (code) => resolve(code ?? -1));
    });

    if (exitCode !== 0) {
      const snippet = cloneStderr.trim().split("\n").slice(-5).join("\n");
      process.stderr.write(`sivru from-git: git clone failed (exit ${exitCode})\n${snippet}\n`);
      return 1;
    }

    const head = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    if (head.code === 0 && head.stdout.trim().length > 0) {
      headSha = head.stdout.trim();
    } else {
      headSha = await readHeadFromDotGit(dotGit);
    }
  }

  const resolvedHead = headSha ?? "unknown";

  if (json) {
    const payload = {
      url,
      ref: ref ?? "HEAD",
      headSha: resolvedHead,
      path: dir,
      cached,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }

  process.stdout.write(`cloned ${url} @ ${resolvedHead} -> ${dir}\n`);
  process.stdout.write(`run \`sivru search "<query>" ${dir}\` to query\n`);
  return 0;
}
