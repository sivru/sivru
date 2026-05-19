// Routing-prompt corpus for the §5 efficacy smoke test (DESIGN-0003 §5).
//
// Each prompt is labelled with its query shape and the tool a correctly
// routed agent should reach for. Success is routing *correctness* — a
// behavioural query should pick sivru.search, an identifier query should
// pick grep — not "shifted toward sivru" (DESIGN-0003 §5, finding 1).
//
// Small and rough by design: this is the seed corpus for the v0.16
// skill-efficacy bench, not that bench.

export type QueryShape = "behavioural" | "identifier";
export type ExpectedTool = "sivru-search" | "grep";

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
    id: "ident-import-search",
    prompt: 'Find every file that imports from "@sivru/search".',
    shape: "identifier",
    expected: "grep",
  },
  {
    id: "ident-symbol-def",
    prompt: "Show me the definition of the SivruIndex class.",
    shape: "identifier",
    expected: "grep",
  },
  {
    id: "ident-exact-string",
    prompt: 'Find the exact string "SIVRU-E001" in the codebase.',
    shape: "identifier",
    expected: "grep",
  },
];
