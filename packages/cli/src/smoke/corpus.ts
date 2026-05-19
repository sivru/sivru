// Routing-prompt corpus for the §5 efficacy smoke test (DESIGN-0003 §5).
//
// This is the testbench. Each prompt is a labelled example: its query shape
// and the tool a correctly routed agent should reach for. Success is routing
// *correctness* — a behavioural query picks sivru.search, an identifier query
// picks grep, an after-edit query picks find_related — not "shifted toward
// sivru" (DESIGN-0003 §5, finding 1).
//
// LIVING TESTBENCH — keep enhancing it. See src/smoke/TESTBENCH.md for how to
// add cases. corpus.test.ts guards a minimum count per shape so the bench can
// only grow, never quietly shrink. This is the seed corpus for the v0.16
// skill-efficacy bench.

export type QueryShape = "behavioural" | "identifier" | "after-edit";
export type ExpectedTool = "sivru-search" | "grep" | "find-related";

export type RoutingPrompt = {
  /** Stable id for reporting. */
  id: string;
  /** The prompt handed to the agent. */
  prompt: string;
  /** Query shape this prompt exercises. */
  shape: QueryShape;
  /** The tool a correctly routed agent should pick. */
  expected: ExpectedTool;
};

export const ROUTING_CORPUS: readonly RoutingPrompt[] = [
  // --- behavioural: natural-language "how/where does X work" → sivru.search
  {
    id: "behav-auth-refresh",
    prompt: "Where is auth token refresh handled in this repo?",
    shape: "behavioural",
    expected: "sivru-search",
  },
  {
    id: "behav-retry-backoff",
    prompt: "How does retry backoff work in this codebase?",
    shape: "behavioural",
    expected: "sivru-search",
  },
  {
    id: "behav-request-signing",
    prompt: "Where do we sign outbound requests?",
    shape: "behavioural",
    expected: "sivru-search",
  },
  {
    id: "behav-index-staleness",
    prompt: "How does the search index decide a file is stale and needs reindexing?",
    shape: "behavioural",
    expected: "sivru-search",
  },
  {
    id: "behav-error-surface",
    prompt: "How do errors from a failed search get surfaced to the user?",
    shape: "behavioural",
    expected: "sivru-search",
  },
  {
    id: "behav-rerank-flow",
    prompt: "Explain how reranking fits into the retrieval pipeline.",
    shape: "behavioural",
    expected: "sivru-search",
  },

  // --- identifier: exact known token / string → grep
  {
    id: "ident-import-search",
    prompt: 'Find every file that imports from "@sivru/search".',
    shape: "identifier",
    expected: "grep",
  },
  {
    id: "ident-symbol-def",
    prompt: "Show me the definition of the SivruIndex type.",
    shape: "identifier",
    expected: "grep",
  },
  {
    id: "ident-exact-string",
    prompt: 'Find the exact string "CACHE_FORMAT_VERSION" in the codebase.',
    shape: "identifier",
    expected: "grep",
  },
  {
    id: "ident-buildindex-callsites",
    prompt: "List every call site of the function named buildIndex.",
    shape: "identifier",
    expected: "grep",
  },
  {
    id: "ident-todo-marker",
    prompt: 'Find all occurrences of the literal "TODO" in packages/search.',
    shape: "identifier",
    expected: "grep",
  },

  // --- after-edit: "I changed this region, what else is affected" → find_related
  {
    id: "afteredit-mcp-entry",
    prompt:
      "I just edited packages/cli/src/mcp-entry.ts lines 95-140. Find the code most related to that region so I can check nothing broke.",
    shape: "after-edit",
    expected: "find-related",
  },
  {
    id: "afteredit-search-core",
    prompt:
      "I changed the function in packages/search/src/search.ts around lines 360-385. What other code is related to it?",
    shape: "after-edit",
    expected: "find-related",
  },
  {
    id: "afteredit-skill-cmd",
    prompt:
      "I modified packages/cli/src/commands/skill.ts lines 110-180. Show me related code and tests before I finish.",
    shape: "after-edit",
    expected: "find-related",
  },
  {
    id: "afteredit-chunk-region",
    prompt:
      "After editing packages/cli/src/skill-asset.ts lines 25-50, find the chunks most similar to that region.",
    shape: "after-edit",
    expected: "find-related",
  },
];
