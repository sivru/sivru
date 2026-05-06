// Shared parsers for sivru.search payloads. The MCP wire format wraps the
// real result inside `{content: [{type: "text", text: "<json string>"}]}`,
// so callers get back any of:
//
//   - already-parsed `{results: [...]}` object
//   - JSON-stringified `{results: [...]}` body
//   - MCP envelope wrapping either of the above
//
// Both the timeline row (TimelineEvent) and the inspector view
// (SivruSearchView) need to read this. Pre-extraction the same recursive
// parsing ran in two files, which would have silently drifted on the
// next MCP SDK bump. Single source of truth lives here.

export type SearchInput = {
  query: string;
  hybrid?: boolean;
  top?: number;
  path?: string;
};

export type SearchHit = {
  filePath: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  preview?: string;
  text?: string;
  source?: string;
};

export type SearchResult = {
  results?: SearchHit[];
  hits?: SearchHit[];
  query?: string;
  mode?: string;
  hybrid?: boolean;
  latencyMs?: number;
};

export function parseSearchInput(input: unknown): SearchInput | null {
  if (input === null || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  if (typeof i.query !== "string") return null;
  const out: SearchInput = { query: i.query };
  if (typeof i.hybrid === "boolean") out.hybrid = i.hybrid;
  if (typeof i.top === "number") out.top = i.top;
  if (typeof i.path === "string") out.path = i.path;
  return out;
}

/**
 * Recursively unwrap whatever shape the agent / SDK serialized the search
 * result in. Returns null on any shape mismatch — callers fall back to the
 * raw output rendering. We bound the recursion to 3 levels to keep
 * pathological inputs from hanging the UI.
 */
export function parseSearchOutput(
  output: unknown,
  depth = 0,
): SearchResult | null {
  if (depth > 3) return null;
  if (output === null || output === undefined) return null;
  if (typeof output === "string") {
    try {
      return parseSearchOutput(JSON.parse(output), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (Array.isArray(o.content)) {
    const first = o.content[0] as { text?: unknown } | undefined;
    if (first !== undefined && typeof first.text === "string") {
      return parseSearchOutput(first.text, depth + 1);
    }
  }
  if (Array.isArray(o.results) || Array.isArray(o.hits)) {
    return o as unknown as SearchResult;
  }
  return null;
}

export function getHits(result: SearchResult | null): SearchHit[] {
  if (result === null) return [];
  if (Array.isArray(result.results)) return result.results;
  if (Array.isArray(result.hits)) return result.hits;
  return [];
}

export function getResultCount(output: unknown): number | null {
  const parsed = parseSearchOutput(output);
  if (parsed === null) return null;
  return getHits(parsed).length;
}

export function getLatencyMs(output: unknown): number | null {
  const parsed = parseSearchOutput(output);
  if (parsed === null) return null;
  return typeof parsed.latencyMs === "number" ? parsed.latencyMs : null;
}

/**
 * One-line input description for the timeline row, e.g.
 * `"auth middleware" · hybrid · top=5`. Returns null if the input doesn't
 * look like a sivru.search call.
 */
export function describeSearchInput(input: unknown): string | null {
  const parsed = parseSearchInput(input);
  if (parsed === null) return null;
  const mode = parsed.hybrid === false ? "bm25" : "hybrid";
  const top = parsed.top ?? 10;
  const truncated =
    parsed.query.length > 60 ? parsed.query.slice(0, 59) + "…" : parsed.query;
  return `"${truncated}"  ·  ${mode}  ·  top=${top}`;
}
