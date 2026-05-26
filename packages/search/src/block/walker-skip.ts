// Single source of truth for "path segments that block-aware walkers
// skip" (CLI + graph + future check-bridges crawl). The repo-root
// `.gitignore` is invisible when the walker is invoked against a sub-
// tree (`packages/search/`), so test fixtures + dist + node_modules
// must be filtered out here.

const SKIP_PATH_SEGMENTS: readonly string[] = [
  "/dist/",
  "/node_modules/",
  "/__fixtures__/",
  "/.git/",
];

export function isBlockWalkSkippable(absPath: string): boolean {
  const normalized = absPath.replace(/\\/g, "/");
  for (const seg of SKIP_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return true;
  }
  return false;
}
