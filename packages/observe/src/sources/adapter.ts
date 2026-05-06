// Sivru observe — pluggable session source interface.
// See DESIGN.md §5.2 (sources). Today the only impl is jsonl; W6 adds a
// hook-stream impl. The HTTP/WS server consumes this interface so swapping
// sources doesn't ripple through downstream code.

import type { Session, SivruEvent } from "../types.js";

/**
 * Plug-in source: jsonl, hooks (W6), or anything else. The HTTP/WS server
 * (W6) consumes the same interface so swapping sources doesn't ripple.
 */
export type SessionSource = {
  /** List sessions known to this source. */
  listSessions(): Promise<Session[]>;
  /** Stream events for one session, oldest first. */
  readSession(sessionPath: string): AsyncIterable<SivruEvent>;
};
