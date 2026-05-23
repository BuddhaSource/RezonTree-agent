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
  // `retryable` tells the agent whether the same tool call MAY succeed
  // if re-attempted without changing inputs. Pre-#616 agents had to
  // parse error strings ("transient", "rate limited", "503") to decide.
  // Now the classification is computed once at the boundary so every
  // agent sees the same answer. Computed via classifyRetryable() unless
  // the caller passes an explicit override (e.g. broadcast/contract
  // surfaces that know their reverts are permanent).
  readonly retryable: boolean;

  constructor(opts: {
    code: string;
    message: string;
    action: string;
    requestId?: string;
    httpStatus?: number;
    details?: Record<string, unknown>;
    retryable?: boolean;
  }) {
    const retryable =
      opts.retryable ??
      classifyRetryable({ code: opts.code, httpStatus: opts.httpStatus });
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
      retryable,
      details: opts.details ?? null,
    };
    super(JSON.stringify(envelope));
    this.name = "StructuredMCPError";
    this.code = opts.code;
    this.action = opts.action;
    this.requestId = opts.requestId;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    this.retryable = retryable;
  }
}

// classifyRetryable — deterministic mapping from (code, httpStatus) to
// a retryable flag. Agents read `error.retryable` from the wire envelope
// to decide whether to back off and retry the same call, or fail the
// step and route to a recovery path.
//
// Retryable=true: transient surface conditions where the underlying
// state may resolve without changing inputs (5xx, network blips, the
// auth-transport blip that yields AUTH_HTTP_503).
//
// Retryable=false: permanent decisions (4xx client errors, validation
// failures, contract reverts, missing config). Re-issuing the same call
// will reach the same outcome. Caller MUST either change inputs or stop.
//
// Anything unknown defaults to NOT retryable — the safer floor when an
// agent is burning budget on retry loops.
export function classifyRetryable(opts: {
  code: string;
  httpStatus?: number;
}): boolean {
  const code = opts.code;
  const status = opts.httpStatus ?? 0;

  // Transient HTTP surfaces from upstream (LB, proxy, backend), or a
  // backend that explicitly emits 503/504 during a brief outage. The
  // agent's retry on the same body has a real chance of succeeding.
  if (status === 502 || status === 503 || status === 504) return true;
  if (status === 408 || status === 429) return true;

  // Non-envelope synthetic codes minted by parseBackendErrorEnvelope
  // for the same set of statuses (HTTP_503, AUTH_HTTP_503, etc.).
  if (/^(?:AUTH_)?HTTP_(?:408|429|502|503|504)$/.test(code)) return true;

  // Auth transport flake — DNS resolution, TCP reset on /v1/sessions.
  // A second attempt commonly succeeds. AUTH_REFRESH_FAILED is NOT in
  // this bucket: it's a second-consecutive 401 meaning the wallet was
  // revoked or the JWT signing key rotated — retrying won't help.
  if (code === "AUTH_TRANSPORT_FAILED") return true;

  // Backend-emitted retryable hints — explicit list. Add new ones here
  // (not in the call site) so the policy stays centralised.
  if (code === "INTENT_EXPIRED_WITH_TIME_LEFT") return true;

  // Permanent client surface — 4xx validation, auth refusal, conflict.
  // Re-posting the same envelope yields the same answer. The agent must
  // change inputs (validation), present a different identity (401/403),
  // or skip (404/409).
  if (status >= 400 && status < 500) return false;

  // Local-MCP synthetic codes that are always permanent: missing config,
  // bad input shape, preflight contract mismatches, AUTH_REFRESH_FAILED.
  // Listing explicitly so a typo or new code lands as non-retryable
  // (safe default) rather than accidentally enabling retry storms.
  const PERMANENT_LOCAL = new Set<string>([
    "STRUCTURED_INPUT_INVALID",
    "AUTH_CONFIG_MISSING",
    "AUTH_REFRESH_FAILED",
    "INSUFFICIENT_BALANCE",
    "PREFLIGHT_MISSING_FEE_SHARE_BPS",
    "PREFLIGHT_MISSING_FEE_SHARES",
    "PREFLIGHT_MISSING_INTENT_HASH",
    "SUBMIT_SOLUTION_PARTIAL_FAILURE",
    "CAST_VOTE_PARTIAL_FAILURE",
    "POST_QUESTION_SPONSOR_FAILED",
    "VOTE_SALT_MISSING",
    "VOTE_SOLUTION_NOT_FOUND",
    "VOTE_FRACTIONAL_POINTS",
    "VOTE_BPS_SUM_MISMATCH",
    "NOT_PARTICIPANT",
    "QUESTION_NOT_ON_CHAIN",
    "ROUND_NOT_SETTLED",
    "STALE_DRAFT_ROW",
    "WAIT_CONFIRMATION_TIMEOUT",
    "WAIT_CONFIRMATION_REJECTED",
  ]);
  if (PERMANENT_LOCAL.has(code)) return false;

  // Default floor: not retryable. Cheaper to be told "stop" once than to
  // burn an agent's budget on a loop with no exit condition.
  return false;
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
