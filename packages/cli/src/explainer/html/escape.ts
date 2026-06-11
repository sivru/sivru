// HTML / JSON escaping for the self-contained explainer (DESIGN-0018 Slice 2).
//
// The model carries repo-derived strings — symbol names, file paths, @sivru
// block prose — that get inlined into HTML text, HTML attributes, and a JSON
// island. Each context needs the right escaping so a value like `</script>` or
// `<img onerror=…>` cannot break the page or inject script. No existing escaper
// lived in the repo, so this is the shared one.

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape a string for HTML element content AND double-quoted attribute values
 * (covers `&<>"'`). Safe for both because we always quote attributes with `"`.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]!);
}

/**
 * Serialize a value for a `<script type="application/json">` island. The only
 * sequence that can terminate the tag early is `</script>`, so escaping every
 * `<` to `<` is sufficient and keeps the output valid JSON that
 * `JSON.parse` reads identically. (Inside `type="application/json"` the browser
 * does NOT HTML-decode entities, so the `<` must be JSON-escaped, not entity-
 * escaped.)
 */
export function jsonIsland(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
