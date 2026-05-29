// W5 — Sivru observe public surface.
// See ../../../DESIGN.md §5 (observe architecture) and §22.2 (cost analytics).
//
// PRIVACY GUARANTEE (DESIGN.md §5.5):
// This package MUST NOT make network calls. Enforced at lint + runtime tests.
// Model file download lives in @sivru/search only.

export const SIVRU_OBSERVE_VERSION = "0.7.0";

export type { Session, SivruEvent, SivruEventKind } from "./types.js";
export type { SessionSource } from "./sources/adapter.js";
export {
  createJsonlSource,
  listSessions,
  readSession,
} from "./sources/jsonl/index.js";
export type { JsonlSourceOptions } from "./sources/jsonl/index.js";
export { createObserveServer, createObserveApp } from "./server/index.js";
export type { ObserveServerOptions, ObserveServer } from "./server/index.js";

export { estimateSavings, summarizeEvents } from "./cost/savings.js";
export type { SavingsEstimate, SavingsOptions, TurnCost } from "./cost/savings.js";
export {
  blendedRateUsdPerMTok,
  lookupPricing,
  MODEL_PRICING,
  turnCostUsd,
} from "./cost/pricing.js";
export type { ModelPricing } from "./cost/pricing.js";

// DESIGN-0021 slot 2 — shared block-write handlers + feedback store, so the CLI
// MCP tools can call the exact same implementation the HTTP routes use.
export {
  applyAutofix,
  editBlock,
  acknowledgeDiagnostic,
  appendFeedbackRecord,
  readFeedbackRecords,
} from "./handlers/block/index.js";
export type { HandlerContext, FeedbackInput } from "./handlers/block/index.js";
export type { HandlerResult, HandlerErrorCode } from "./handlers/block/result.js";
export type { FeedbackRecord, FeedbackKind, FeedbackActor, DiagnosticRef } from "./feedback/index.js";
export { sweepAuditRetention } from "./audit/index.js";
export { migrateLegacyAcknowledgments } from "./feedback/index.js";
export { loadObserveConfig, auditRetentionDays, defaultSubview } from "./config.js";
export type { ObserveConfig } from "./config.js";

export { replaySession, aggregateReplay } from "./replay/index.js";
export type {
  AggregateReport,
  AggregateSession,
  AggregateSessionResult,
  ReplayOptions,
  ReplayResult,
  ReplayTotals,
  ReplayedEvent,
  ReplayedEventKind,
} from "./replay/index.js";
