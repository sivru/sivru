// Directory → level mapping for the explainer model (DESIGN-0018 Slice 1).
//
// The one ambiguous rule, so it lives in its own pure module with its own test
// on both repo shapes:
//
//   Monorepo (sivru):  module = workspace package dir   (packages/cli)
//                      package = first src subdir        (commands, lib, …)
//   Single-package:    module = repo root ("")           → module/package
//                      package = first src subdir          collapse onto one module
//
// All paths are repo-relative POSIX ("/"-separated), as the symbol index emits.

/**
 * The module directory a file belongs to: the deepest package-root prefix
 * (a directory that contains a package.json). With one package root (single
 * package repo) every file maps to it, collapsing the module level onto one
 * node. `pkgDirs` must be sorted so the deepest match wins; we sort defensively.
 */
export function moduleDirOf(
  filePath: string,
  pkgDirs: readonly string[],
): string {
  let best = ""; // repo root is always an implicit fallback module
  for (const dir of pkgDirs) {
    if (dir === "") continue;
    if (filePath === dir || filePath.startsWith(dir + "/")) {
      if (dir.length > best.length) best = dir;
    }
  }
  return best;
}

/**
 * The package segment within a module: the first path segment of the file
 * relative to its module dir, after stripping a leading `src/`. Files that sit
 * directly under the module (or its src/) get the sentinel `(root)` so they
 * still have a package home instead of vanishing.
 */
export function packageSegOf(filePath: string, moduleDir: string): string {
  let rel = moduleDir === "" ? filePath : filePath.slice(moduleDir.length + 1);
  if (rel.startsWith("src/")) rel = rel.slice(4);
  const slash = rel.indexOf("/");
  // No further slash → the file is a direct child (e.g. src/index.ts) → root pkg.
  return slash === -1 ? "(root)" : rel.slice(0, slash);
}
