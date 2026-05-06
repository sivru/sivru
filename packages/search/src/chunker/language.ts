// File-extension → language id (matches DESIGN.md §4.1's 16 grammars).
//
// `null` means "no language recognized" — chunkers fall through to line-mode.

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".pyi": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".php": "php",
  ".swift": "swift",
};

/** Lower-cased extension lookup, including the leading dot. Returns `null` for unknown. */
export function detectLanguage(filePath: string): string | null {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = filePath.slice(lastSlash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension or a dotfile like `.bashrc`
  const ext = base.slice(dot).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}
