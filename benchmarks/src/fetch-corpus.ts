// Clone (or refresh) every benchmark repo to its pinned SHA under
// `benchmarks/corpus/<name>/`. Local-developer step — `corpus/` is gitignored
// so the repo stays standalone.
//
// Run via `pnpm --filter @sivru/benchmarks fetch-corpus`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RepoSpec } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const CORPUS_DIR = resolve(ROOT, "benchmarks", "corpus");

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function ensureRepo(repo: RepoSpec): void {
  const target = resolve(CORPUS_DIR, repo.name);
  if (existsSync(resolve(target, ".git"))) {
    const head = git(target, ["rev-parse", "HEAD"]);
    if (head === repo.revision) {
      process.stdout.write(`  ${repo.name}: already at ${repo.revision.slice(0, 7)}\n`);
      return;
    }
    process.stdout.write(`  ${repo.name}: fetching ${repo.revision.slice(0, 7)}\n`);
    try {
      git(target, ["fetch", "--depth", "1", "origin", repo.revision]);
    } catch {
      // The pinned SHA might not be reachable via shallow fetch; fall back
      // to a full fetch.
      git(target, ["fetch", "origin"]);
    }
    git(target, ["checkout", "-q", repo.revision]);
    return;
  }
  process.stdout.write(`  ${repo.name}: cloning ${repo.url}\n`);
  mkdirSync(target, { recursive: true });
  git(CORPUS_DIR, ["clone", "--quiet", repo.url, repo.name]);
  git(target, ["checkout", "-q", repo.revision]);
}

function main(): void {
  mkdirSync(CORPUS_DIR, { recursive: true });
  const reposPath = resolve(ROOT, "benchmarks", "repos.json");
  const repos = JSON.parse(readFileSync(reposPath, "utf8")) as RepoSpec[];
  process.stdout.write(`Fetching ${repos.length} corpus repos into ${CORPUS_DIR}\n`);
  for (const repo of repos) {
    ensureRepo(repo);
  }
  process.stdout.write("Done.\n");
}

main();
