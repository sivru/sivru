// Shared result envelope for block/feedback write operations (DESIGN-0021
// §"Error envelope"). The SAME shape backs both the MCP tools (returned as-is)
// and the HTTP mutation routes (as the JSON body of 4xx/5xx responses), so the
// UI and agent paths share one error contract.

export type HandlerErrorCode =
  | "SIVRU-WRITABLE-DISABLED"
  | "SIVRU-PATH-OUTSIDE-ROOT"
  | "SIVRU-FILE-NOT-FOUND"
  | "SIVRU-FILE-CHANGED" // mtime mismatch (409 equivalent)
  | "SIVRU-VALIDATION-FAILED"
  | "SIVRU-AUTOFIX-RAISED"
  | "SIVRU-INTERNAL-ERROR";

export type HandlerResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: HandlerErrorCode; message: string; retryable: boolean; data?: unknown };

export function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

export function err<T>(
  code: HandlerErrorCode,
  message: string,
  retryable: boolean,
  data?: unknown,
): HandlerResult<T> {
  return data === undefined
    ? { ok: false, code, message, retryable }
    : { ok: false, code, message, retryable, data };
}

/** HTTP status for each error code — keeps route mapping in one place. */
export function httpStatusFor(code: HandlerErrorCode): 400 | 404 | 405 | 409 | 500 {
  switch (code) {
    case "SIVRU-WRITABLE-DISABLED":
      return 405;
    case "SIVRU-PATH-OUTSIDE-ROOT":
      return 400;
    case "SIVRU-FILE-NOT-FOUND":
      return 404;
    case "SIVRU-FILE-CHANGED":
      return 409;
    case "SIVRU-VALIDATION-FAILED":
      return 400;
    case "SIVRU-AUTOFIX-RAISED":
    case "SIVRU-INTERNAL-ERROR":
      return 500;
  }
}
