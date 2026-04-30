// Error reporting types — cartridge loop 0064.
//
// Taxonomy + shape. Sink implementations consume these; the
// Reporter classifies raw Errors into the severity-tagged
// shape before fanning out to sinks.

/**
 * Severity classes map to routing behavior:
 *
 *   "info"    — non-actionable; stderr sink only
 *   "agent"   — retry-safe network/transient; file-sink + stderr
 *   "protocol"— backend VALIDATION_ERROR / AGENT_RESTRICTED /
 *               teaching-action errors; file + webhook + stderr
 *   "wallet"  — insufficient funds, nonce conflict, RPC timeout;
 *               file + webhook + stderr (plus caller retries
 *               with backoff)
 *   "fatal"   — misconfigured mnemonic, bad RPC URL; file +
 *               webhook + stderr, then exit 1
 */
export type ErrorClass = "info" | "agent" | "protocol" | "wallet" | "fatal";

export interface ErrorReport {
  timestamp: string; // ISO-8601, always UTC
  unix_seconds: number; // machine-friendly primary key
  errorClass: ErrorClass;
  agentName?: string;
  agentIndex?: number;
  /** When the source was a structured backend error, the
   *  `error.code` value (e.g. "VALIDATION_ERROR",
   *  "RATE_LIMITED"). When the source was a raw Error, the
   *  constructor name (e.g. "Error", "TypeError"). */
  code: string;
  message: string;
  /** Backend teaching action, when the source carried one. */
  action?: string;
  /** Backend request_id, when the source carried one. */
  request_id?: string;
  /** Stack trace, redacted where useful. */
  stack?: string;
  /** Freeform context — the call site attaches whatever is
   *  useful for triage (questionId, roundId, tool name, etc.). */
  context?: Record<string, unknown>;
}

/** Each sink is a tiny adapter that writes an ErrorReport
 *  somewhere. Returns a promise so the Reporter can parallelize
 *  fan-out + gather failures without blocking the hot path. */
export interface Sink {
  /** Stable name for diagnostics / test assertions. */
  name: string;
  write(report: ErrorReport): Promise<void>;
  /** Idempotent; flush-and-close. Reporter calls this on
   *  graceful shutdown so the webhook's debounced queue
   *  drains. */
  close?(): Promise<void>;
}
