// errors.ts — backend → MCP error envelope surfacing.
//
// The backend's AppError envelope is `{ error: { code, message,
// action, requestId, details?, fieldErrors? } }`. This module
// converts that envelope into a thrown error the MCP SDK serializes
// to the LLM caller verbatim. Living in its own file so the unit
// test suite can import it without paying the cost of evaluating
// server.ts (which binds stdio on import).
//
// Top-level shape on the wire is:
//   { ok: false, errorCode, errorMessage, errorAction,
//     requestId, httpStatus, details }
//
// The four prescriptive fields (errorCode / errorMessage /
// errorAction / requestId) sit at the TOP level so the LLM
// consuming the tool result can pattern-match on them without
// re-parsing a nested object. `details` carries every other key
// the backend returned under `error` — SCHEMA_CHANGED's `diff` /
// `schema`, validation's `fieldErrors`, AGENT_RESTRICTED's
// `restricted_action` / `entity_id`, INSUFFICIENT_BALANCE's
// breakdown, etc. — so no information from the backend's error
// payload is lost in transit.

export class StructuredMCPError extends Error {
  readonly code: string;
  readonly action: string;
  readonly requestId?: string;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;

  constructor(opts: {
    code: string;
    message: string;
    action: string;
    requestId?: string;
    httpStatus?: number;
    details?: Record<string, unknown>;
  }) {
    // The MCP SDK serializes the thrown Error's `.message` verbatim.
    // Setting it to the wire envelope means tools that bottom out in
    // `.message` (legacy harness) still emit structured output.
    const envelope = {
      ok: false,
      errorCode: opts.code,
      errorMessage: opts.message,
      errorAction: opts.action,
      requestId: opts.requestId ?? null,
      httpStatus: opts.httpStatus ?? null,
      details: opts.details ?? null,
    };
    super(JSON.stringify(envelope));
    this.name = "StructuredMCPError";
    this.code = opts.code;
    this.action = opts.action;
    this.requestId = opts.requestId;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
  }
}

// parseBackendErrorEnvelope — pure / no side effects. Takes the
// parsed JSON body of a non-2xx response, the raw text (for non-
// envelope fall-through), the HTTP status, and a code-prefix
// (auth uses AUTH_HTTP_ instead of HTTP_), and returns the
// constructor args for StructuredMCPError that preserve every
// field the backend sent. Wire field is requestId (camelCase) per
// AppError.ToResponse; request_id snake_case is accepted as a
// fallback so older backend builds still surface their requestId.
export function parseBackendErrorEnvelope(opts: {
  data: unknown;
  rawText: string;
  status: number;
  codePrefix?: "HTTP_" | "AUTH_HTTP_";
  fallbackAction: string;
}): {
  code: string;
  message: string;
  action: string;
  requestId?: string;
  httpStatus: number;
  details?: Record<string, unknown>;
} {
  const prefix = opts.codePrefix ?? "HTTP_";
  const env = (opts.data as { error?: Record<string, unknown> } | null)?.error;
  if (env && typeof env === "object") {
    const {
      code: _code,
      message: _message,
      action: _action,
      requestId: _requestId,
      request_id: _requestIdSnake,
      ...rest
    } = env as Record<string, unknown>;
    const restDetails = Object.keys(rest).length > 0 ? rest : undefined;
    return {
      code: (env.code as string) ?? `${prefix}${opts.status}`,
      message:
        (env.message as string) ?? `Backend returned HTTP ${opts.status}`,
      action: (env.action as string) ?? opts.fallbackAction,
      requestId:
        (env.requestId as string | undefined) ??
        (env.request_id as string | undefined),
      httpStatus: opts.status,
      details: restDetails,
    };
  }
  const bodySnippet =
    opts.rawText.length > 0 ? opts.rawText.slice(0, 500) : `HTTP ${opts.status}`;
  return {
    code: `${prefix}${opts.status}`,
    message: bodySnippet,
    action:
      "Backend returned a non-envelope response (likely upstream proxy or LB). Check backend logs.",
    requestId: undefined,
    httpStatus: opts.status,
  };
}
