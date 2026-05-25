import type {
  AggregateSavings,
  Session,
  SessionReplay,
  SessionSavings,
  SivruEvent,
} from "./types";

export type HealthResponse = { ok: true; version: string };
export type SessionsResponse = { sessions: Session[] };
export type EventsResponse = { sessionId: string; events: SivruEvent[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/api/health");
}

export function fetchSessions(): Promise<SessionsResponse> {
  return getJson<SessionsResponse>("/api/sessions");
}

export function fetchEvents(
  sessionId: string,
  limit = 500,
): Promise<EventsResponse> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`;
  return getJson<EventsResponse>(url);
}

export function fetchSessionSavings(sessionId: string): Promise<SessionSavings> {
  return getJson<SessionSavings>(
    `/api/sessions/${encodeURIComponent(sessionId)}/savings`,
  );
}

export function fetchSessionReplay(sessionId: string): Promise<SessionReplay> {
  return getJson<SessionReplay>(
    `/api/sessions/${encodeURIComponent(sessionId)}/replay`,
  );
}

export function fetchAggregateSavings(sinceDays?: number): Promise<AggregateSavings> {
  const q = sinceDays !== undefined ? `?since=${sinceDays}` : "";
  return getJson<AggregateSavings>(`/api/savings${q}`);
}

// /api/checkup — DESIGN-0005 §2 + §6. Returns a CheckupReport JSON shape.
// The UI types mirror the library types (kept local so the UI package
// doesn't take a runtime dep on @sivru/observe).
export type CheckupSeverity = "info" | "warning" | "error";
export type CheckupMemoryFileKind = "claude-md" | "skill" | "agent";

export type CheckupMemoryFile = {
  path: string;
  displayPath: string;
  kind: CheckupMemoryFileKind;
  mtimeMs: number;
  lastCommitTs?: number;
  commitsBehindHead?: number;
  unreadable?: boolean;
};

export type CheckupFinding = {
  checkId: string;
  severity: CheckupSeverity;
  filePath: string;
  line?: number;
  summary: string;
  detail?: string;
  data?: Record<string, unknown>;
};

export type CheckupDiagnostic = {
  code: string;
  severity: CheckupSeverity;
  message: string;
};

export type CheckupReport = {
  schema: 1;
  repoRoot: string;
  ranAt: string;
  files: CheckupMemoryFile[];
  findings: CheckupFinding[];
  diagnostics: CheckupDiagnostic[];
};

export function fetchCheckup(path: string): Promise<CheckupReport> {
  return getJson<CheckupReport>(`/api/checkup?path=${encodeURIComponent(path)}`);
}

// Bench history — feeds the "Bench" tab. Returns past `sivru bench
// personal` runs written to ~/.cache/sivru/bench-history/. Schema lives
// alongside the writer in packages/cli/src/lib/bench-history.ts; the
// observe server validates formatVersion before returning.

export type BenchRunSummary = { id: string; startedAt: string };
export type BenchRunListResponse = { runs: BenchRunSummary[] };

export type BenchRunModel = {
  model: string;
  label: string;
  perQuerySaved: number[];
  meanSavedPct: number;
  ci: { p05: number; p50: number; p95: number };
  buildMs: number;
  searchMs: number;
  // Newer fields — present in runs after the IR-correctness overhaul.
  // Older runs leave them undefined and the UI hides those columns.
  perQueryRecallAt5?: number[];
  perQueryMRR?: number[];
  scoreableQueryIndices?: number[];
  medianSavedPct?: number;
  meanRecallAt5?: number;
  medianRecallAt5?: number;
  meanMRR?: number;
  medianMRR?: number;
  recallCI?: { p05: number; p50: number; p95: number };
  mrrCI?: { p05: number; p50: number; p95: number };
  queriesScoredForRecall?: number;
};

export type BenchRunQueryDetail = {
  query: string;
  source: "search_call" | "user_message";
  relevantFiles: string[];
};

export type BenchRunRepo = {
  project: string;
  basename: string;
  sessionCount: number;
  queries: string[];
  queryDetails?: BenchRunQueryDetail[];
  models: BenchRunModel[];
};

export type BenchRunDetail = {
  formatVersion: number;
  startedAt: string;
  sivruVersion: string;
  node: string;
  platform: string;
  argv: string[];
  repos: BenchRunRepo[];
};

export function fetchBenchRuns(): Promise<BenchRunListResponse> {
  return getJson<BenchRunListResponse>("/api/bench-history");
}

export function fetchBenchRun(id: string): Promise<BenchRunDetail> {
  return getJson<BenchRunDetail>(`/api/bench-history/${encodeURIComponent(id)}`);
}

export type EventStreamHandle = {
  /** Close the stream and stop receiving events. */
  close: () => void;
};

/**
 * Open an SSE connection to /api/sessions/:id/stream and call `onEvent`
 * for each event as it arrives. The first call delivers the existing
 * events in the session (one per call), subsequent calls deliver new
 * events as they're appended to the jsonl file. `onError` fires if the
 * connection fails; the caller may close + reopen.
 */
export function subscribeToEvents(
  sessionId: string,
  onEvent: (event: SivruEvent) => void,
  onError?: (err: Event) => void,
): EventStreamHandle {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/stream`;
  const es = new EventSource(url);

  // The server emits messages with the named event "event". Listening on the
  // matching name (rather than the default "message") is required.
  es.addEventListener("event", (ev: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(ev.data) as SivruEvent;
      onEvent(parsed);
    } catch {
      // Malformed payload — drop. The server controls the format so this
      // would only fire under transport corruption; surface via onError so
      // callers can decide whether to reconnect.
      if (onError !== undefined) onError(ev);
    }
  });

  if (onError !== undefined) {
    es.onerror = (ev) => {
      onError(ev);
    };
  }

  return {
    close: () => {
      es.close();
    },
  };
}
