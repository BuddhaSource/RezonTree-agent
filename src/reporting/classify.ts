// Error classification — cartridge loop 0064.
//
// Raw Errors → ErrorClass. The Reporter uses this to decide
// routing (which sinks to fan out to + whether to exit after).
//
// Classification is conservative: when ambiguous, the class
// inflates to the more-alerting side. A protocol-level error
// that happens to arrive as a network-error-looking message
// still gets the "protocol" treatment if we can detect it.

import type { ErrorClass } from "./types.js";

/** Structured backend error envelope (matches parent
 *  CLAUDE.md's api-contract shape). Thrown objects from the
 *  MCP server's apiCall carry this shape when the backend
 *  returned a JSON error body. */
export interface BackendErrorShape {
  code?: string;
  message?: string;
  action?: string;
  request_id?: string;
}

/** Heuristic: an Error whose message starts with "API error"
 *  (raised by MCP server's apiCall on non-2xx). */
const PROTOCOL_MSG_PREFIX = /^API error \d+: /;

/** Regex for common wallet-layer error messages thrown by
 *  viem / ethers / HTTP RPC clients. */
const WALLET_ERROR_HINTS = [
  /insufficient.*fund/i,
  /nonce/i,
  /RPC|rpc error/i,
  /gas/i,
  /revert/i,
  /chain.{0,10}(id|mismatch)/i,
  /EIP-712/i,
];

const FATAL_ERROR_HINTS = [
  /BIP-39|mnemonic/i,
  /RT_AGENT_MNEMONIC/i,
  /RT_AGENT_INDEX/i,
  /SIGNING_DOMAIN|DOMAIN_SEPARATOR/i,
];

/**
 * Classifies a thrown value into an ErrorClass + code + action.
 *
 * Inputs:
 *   - BackendErrorShape (structured) → "protocol"
 *   - Error whose message has protocol markers → "protocol"
 *   - Error matching wallet hints → "wallet"
 *   - Error matching fatal hints → "fatal"
 *   - Anything else → "agent" (retry-safe default)
 */
export function classifyError(err: unknown): {
  errorClass: ErrorClass;
  code: string;
  message: string;
  action?: string;
  request_id?: string;
  stack?: string;
} {
  // Structured backend error — highest confidence. The MCP
  // server throws `new Error(...)` with a formatted message,
  // but when callers pass the parsed body directly we cover
  // that path too.
  if (isBackendErrorShape(err)) {
    return {
      errorClass: "protocol",
      code: err.code ?? "UNKNOWN_PROTOCOL_ERROR",
      message: err.message ?? "unknown protocol error",
      action: err.action,
      request_id: err.request_id,
    };
  }

  if (err instanceof Error) {
    // Error message starts with "API error NNN:" → it's wrapped
    // from the MCP server's apiCall; parse the code out.
    if (PROTOCOL_MSG_PREFIX.test(err.message)) {
      // Format: "API error 400: CODE — message\nAction: …"
      const codeMatch = err.message.match(/API error \d+: ([A-Z_]+)/);
      const actionMatch = err.message.match(/Action: (.+)$/s);
      return {
        errorClass: "protocol",
        code: codeMatch?.[1] ?? "UNKNOWN_PROTOCOL_ERROR",
        message: err.message,
        action: actionMatch?.[1]?.trim(),
        stack: err.stack,
      };
    }

    if (FATAL_ERROR_HINTS.some((re) => re.test(err.message))) {
      return {
        errorClass: "fatal",
        code: err.constructor.name,
        message: err.message,
        stack: err.stack,
      };
    }

    if (WALLET_ERROR_HINTS.some((re) => re.test(err.message))) {
      return {
        errorClass: "wallet",
        code: err.constructor.name,
        message: err.message,
        stack: err.stack,
      };
    }

    return {
      errorClass: "agent",
      code: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
  }

  // Non-Error thrown (string, number, plain object).
  return {
    errorClass: "agent",
    code: "UnknownThrow",
    message: String(err),
  };
}

function isBackendErrorShape(x: unknown): x is BackendErrorShape {
  if (typeof x !== "object" || x === null) return false;
  // Must have `code` + `message` as strings at minimum.
  const o = x as Record<string, unknown>;
  return typeof o.code === "string" && typeof o.message === "string";
}
