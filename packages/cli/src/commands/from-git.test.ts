import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

import { _internal, runFromGit } from "./from-git.js";

type CapturedSpawn = {
  command: string;
  args: readonly string[];
};

type StubBehavior = (
  command: string,
  args: readonly string[],
) => {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

class FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  constructor(stdoutChunk: string, stderrChunk: string, exitCode: number) {
    super();
    this.stdout = Readable.from([stdoutChunk]);
    this.stderr = Readable.from([stderrChunk]);
    // Emit `close` after stream consumers attach. queueMicrotask gives the
    // caller a chance to register `data`/`close` handlers first.
    queueMicrotask(() => {
      // Consume the streams so 'data' fires for any listener.
      this.stdout.on("data", () => {});
      this.stderr.on("data", () => {});
      // Emit close on next tick after the streams have flushed.
      setImmediate(() => this.emit("close", exitCode));
    });
  }
}

let calls: CapturedSpawn[] = [];
let originalSpawn: typeof _internal.spawn;

function installSpawnStub(behavior: StubBehavior): void {
  originalSpawn = _internal.spawn;
  calls = [];
  _internal.spawn = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const result = behavior(command, args);
    return new FakeChild(
      result.stdout ?? "",
      result.stderr ?? "",
      result.exitCode,
    ) as unknown as ReturnType<typeof _internal.spawn>;
  }) as typeof _internal.spawn;
}

function restoreSpawn(): void {
  if (originalSpawn) {
    _internal.spawn = originalSpawn;
  }
}

type Captured = { stdout: string; stderr: string; restore: () => void };

function captureIO(): Captured {
  const captured: Captured = {
    stdout: "",
    stderr: "",
    restore: () => {},
  };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  captured.restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOut;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErr;
  };
  return captured;
}

let fakeHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(async () => {
  // Redirect ~/.cache/sivru to a tmp dir so tests don't pollute the user's
  // real cache. `os.homedir()` reads $HOME on POSIX and $USERPROFILE on
  // Windows — set both so the redirect works on every CI runner.
  fakeHome = await mkdtemp(join(tmpdir(), "sivru-cli-fromgit-home-"));
  originalHome = process.env["HOME"];
  originalUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = fakeHome;
  process.env["USERPROFILE"] = fakeHome;
});

afterEach(async () => {
  restoreSpawn();
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env["USERPROFILE"];
  } else {
    process.env["USERPROFILE"] = originalUserProfile;
  }
  await rm(fakeHome, { recursive: true, force: true });
});

describe("runFromGit SSRF guard", () => {
  it("rejects file:// scheme", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "file:///etc/passwd"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/scheme/);
  });

  it("rejects javascript: scheme", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "javascript:alert(1)"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/scheme/);
  });

  it("rejects http://localhost", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "http://localhost:8080/repo.git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/private host/);
  });

  it("rejects http://127.0.0.1", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "http://127.0.0.1:8080/repo.git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/private host/);
  });

  it("rejects http://192.168.1.5", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "http://192.168.1.5/repo.git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/private host/);
  });

  it("rejects http://10.0.0.1", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "http://10.0.0.1/repo.git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/private host/);
  });

  it("rejects http://172.16.0.1 (RFC 1918 second-octet boundary)", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "http://172.16.0.1/repo.git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/private host/);
  });

  it("rejects http://169.254.169.254 (link-local)", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "http://169.254.169.254/repo.git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/link-local/);
  });

  it("with --allow-private-urls, localhost is allowed (clone is invoked)", async () => {
    installSpawnStub((_cmd, args) => {
      // First call: `git clone ...`. Second: `git -C <dir> rev-parse HEAD`.
      if (args[0] === "clone") {
        return { exitCode: 0 };
      }
      if (args.includes("rev-parse")) {
        return { exitCode: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
      }
      return { exitCode: 0 };
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit([
        "from-git",
        "http://localhost:8080/repo.git",
        "--allow-private-urls",
        "--json",
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    // SSRF rejection NOT printed.
    expect(cap.stderr).not.toMatch(/private host/);
    // git clone was invoked.
    const clone = calls.find((c) => c.args[0] === "clone");
    expect(clone).toBeDefined();
  });
});

describe("runFromGit argument parsing", () => {
  it("missing url → exit 1 with usage", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/missing url/);
    expect(cap.stderr).toMatch(/usage:/);
  });

  it("unknown flag → exit 2", async () => {
    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "https://example.com/r.git", "--bogus"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/unknown flag: --bogus/);
  });

  it("--ref main passes --branch main to git clone", async () => {
    installSpawnStub((_cmd, args) => {
      if (args[0] === "clone") return { exitCode: 0 };
      if (args.includes("rev-parse"))
        return { exitCode: 0, stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n" };
      return { exitCode: 0 };
    });

    const cap = captureIO();
    try {
      await runFromGit([
        "from-git",
        "https://example.com/repo.git",
        "--ref",
        "main",
        "--json",
      ]);
    } finally {
      cap.restore();
    }
    const clone = calls.find((c) => c.args[0] === "clone");
    expect(clone).toBeDefined();
    expect(clone!.args).toContain("--branch");
    expect(clone!.args).toContain("main");
  });

  it("-r main passes --branch main to git clone", async () => {
    installSpawnStub((_cmd, args) => {
      if (args[0] === "clone") return { exitCode: 0 };
      if (args.includes("rev-parse"))
        return { exitCode: 0, stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n" };
      return { exitCode: 0 };
    });

    const cap = captureIO();
    try {
      await runFromGit(["from-git", "https://example.com/repo.git", "-r", "main", "--json"]);
    } finally {
      cap.restore();
    }
    const clone = calls.find((c) => c.args[0] === "clone");
    expect(clone).toBeDefined();
    expect(clone!.args).toContain("--branch");
    expect(clone!.args).toContain("main");
  });

  it("--ref=main (= form) passes --branch main", async () => {
    installSpawnStub((_cmd, args) => {
      if (args[0] === "clone") return { exitCode: 0 };
      if (args.includes("rev-parse"))
        return { exitCode: 0, stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n" };
      return { exitCode: 0 };
    });

    const cap = captureIO();
    try {
      await runFromGit(["from-git", "https://example.com/repo.git", "--ref=main", "--json"]);
    } finally {
      cap.restore();
    }
    const clone = calls.find((c) => c.args[0] === "clone");
    expect(clone).toBeDefined();
    expect(clone!.args).toContain("main");
  });
});

describe("runFromGit cache reuse", () => {
  it("reuses an existing cache dir and reports cached: true", async () => {
    const url = "https://example.com/cached.git";
    const ref: string | undefined = undefined;
    const hash = createHash("sha256").update(url + "#HEAD").digest("hex");
    const dir = join(fakeHome, ".cache", "sivru", "git", hash);
    const dotGit = join(dir, ".git");
    const knownSha = "1234567890abcdef1234567890abcdef12345678";
    // Pre-create the cache: .git/HEAD pointing at refs/heads/main, and
    // .git/refs/heads/main containing a sha. The stub `rev-parse` returns
    // that sha so the code accepts it as a valid cached clone.
    await mkdir(join(dotGit, "refs", "heads"), { recursive: true });
    await writeFile(join(dotGit, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(dotGit, "refs", "heads", "main"), knownSha + "\n");

    installSpawnStub((_cmd, args) => {
      if (args.includes("rev-parse")) {
        return { exitCode: 0, stdout: knownSha + "\n" };
      }
      return { exitCode: 0 };
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", url, "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    // No clone — cache reused.
    expect(calls.find((c) => c.args[0] === "clone")).toBeUndefined();

    const parsed = JSON.parse(cap.stdout.trim()) as {
      url: string;
      ref: string;
      headSha: string;
      path: string;
      cached: boolean;
    };
    expect(parsed.url).toBe(url);
    expect(parsed.ref).toBe("HEAD");
    expect(parsed.cached).toBe(true);
    expect(parsed.headSha).toBe(knownSha);
    expect(parsed.path).toBe(dir);
  });

  it("re-clones when rev-parse fails on the cached dir", async () => {
    const url = "https://example.com/stale.git";
    const hash = createHash("sha256").update(url + "#HEAD").digest("hex");
    const dir = join(fakeHome, ".cache", "sivru", "git", hash);
    const dotGit = join(dir, ".git");
    await mkdir(dotGit, { recursive: true });
    // No HEAD/refs — `rev-parse` will fail in our stub.

    let revParseCalls = 0;
    installSpawnStub((_cmd, args) => {
      if (args.includes("rev-parse")) {
        revParseCalls++;
        // First rev-parse (cache check): fail. After clone, rev-parse
        // succeeds and returns a sha.
        if (revParseCalls === 1) {
          return { exitCode: 128, stderr: "fatal: not a git repository\n" };
        }
        return { exitCode: 0, stdout: "0000000000000000000000000000000000000000\n" };
      }
      if (args[0] === "clone") {
        return { exitCode: 0 };
      }
      return { exitCode: 0 };
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", url, "--json"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.trim()) as { cached: boolean };
    expect(parsed.cached).toBe(false);
    expect(calls.find((c) => c.args[0] === "clone")).toBeDefined();
  });
});

describe("runFromGit clone failure", () => {
  it("exit 1 with stderr snippet when git clone fails", async () => {
    installSpawnStub((_cmd, args) => {
      if (args[0] === "clone") {
        return { exitCode: 128, stderr: "fatal: repository not found\n" };
      }
      return { exitCode: 0 };
    });

    const cap = captureIO();
    let code: number;
    try {
      code = await runFromGit(["from-git", "https://example.com/missing.git"]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toMatch(/git clone failed/);
    expect(cap.stderr).toMatch(/repository not found/);
  });
});

