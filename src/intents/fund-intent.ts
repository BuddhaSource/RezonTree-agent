// fund-intent.ts — FundIntent EIP-712 typed-data builder + POST
// body builder. Pure functions, no wagmi/network deps — unit-testable.
//
// The struct shape MUST match backend's internal/signer/fund_intent.go
// byte-for-byte:
//
//   FundIntent(
//     bytes32 questionId,
//     address funder,
//     uint256 amount,
//     uint256 nonce,
//     uint256 chainId,
//     uint256 expiresAt
//   )
//
// Any reorder here, any field rename, any type change → the
// struct hash diverges and the Router rejects the signature
// on-chain with RouterBadSigner. Treat this file as a schema
// contract; bump it only in lockstep with the backend signer.
//
// R-CHAIN-VERIFIES-INTENT — the signature is verified on-chain.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt is mandatory and short.

import {
  buildRouterDomain,
  type RouterIntentDomain,
} from "./router-domain.js";
import type { FundPreflight } from "./preflight-types.js";

// ── Typed-data primitives ────────────────────────────────────────

export const FUND_INTENT_TYPES = {
  FundIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "funder", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface FundIntentMessage {
  questionId: `0x${string}`; // 32-byte qid hex
  funder: `0x${string}`;
  amount: bigint;
  nonce: bigint;
  chainId: bigint;
  expiresAt: bigint;
}

export interface FundIntentTypedData {
  domain: RouterIntentDomain;
  types: typeof FUND_INTENT_TYPES;
  primaryType: "FundIntent";
  message: FundIntentMessage;
}

// ── TTL policy ───────────────────────────────────────────────────
// R-INTENT-CARRIES-EXPIRY: every signed intent declares its own
// TTL. 10 minutes is the default client-side choice — comfortably
// past wallet-prompt + broadcast latency, well under the backend's
// MaxPermitTTL of 15 min (loop 0031).
export const DEFAULT_FUND_TTL_SECONDS = 10 * 60;

// ── Builders ─────────────────────────────────────────────────────

/**
 * Constructs the EIP-712 typed-data payload for `wagmi.signTypedData`.
 * All numeric inputs are bigints so the caller never fights JS
 * number precision on wei-scale amounts.
 *
 * The `expiresAt` default anchors to `now + DEFAULT_FUND_TTL_SECONDS`;
 * callers can override for tighter bounds (e.g. clamp to the round's
 * `funding_deadline` when the round deadline is sooner).
 */
export function buildFundIntentTypedData(params: {
  preflight: FundPreflight;
  funder: `0x${string}`;
  amountWei: bigint;
  expiresAtSeconds?: number; // unix seconds; defaults to now + 10min
  /** Override nonce (otherwise consumed from preflight.nonce_next). */
  nonce?: bigint;
  /** Override "now" for deterministic tests. Seconds since epoch. */
  nowSeconds?: number;
}): FundIntentTypedData {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.expiresAtSeconds ?? now + DEFAULT_FUND_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce_next);

  return {
    domain: buildRouterDomain({
      chainId: params.preflight.chain_id,
      routerAddress: params.preflight.router_address as `0x${string}`,
    }),
    types: FUND_INTENT_TYPES,
    primaryType: "FundIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      funder: params.funder,
      amount: params.amountWei,
      nonce,
      chainId: BigInt(params.preflight.chain_id),
      expiresAt: BigInt(ttl),
    },
  };
}

// ── POST body shape ──────────────────────────────────────────────
// Matches backend handler.FundRequest (internal/handler/contribution.go).
// Every value is a string over the wire — decimals for bigints,
// hex for bytes — so JSON parsing doesn't lose precision.

export interface FundRequestBody {
  question_id: string; // 0x hex (32 bytes)
  funder: string; // 0x hex (20 bytes)
  amount: string; // decimal bigint
  nonce: string; // decimal bigint
  chain_id: string; // decimal bigint
  expires_at: string; // decimal unix seconds
  signature: string; // 0x hex (65 bytes)
}

/** Pure builder for the POST /v1/problems/:id/fund request body. */
export function buildFundRequestBody(params: {
  typedData: FundIntentTypedData;
  signature: `0x${string}`;
}): FundRequestBody {
  const m = params.typedData.message;
  return {
    question_id: m.questionId,
    funder: m.funder,
    amount: m.amount.toString(),
    nonce: m.nonce.toString(),
    chain_id: m.chainId.toString(),
    expires_at: m.expiresAt.toString(),
    signature: params.signature,
  };
}

// ── Amount encoding ─────────────────────────────────────────────

/**
 * Converts a human-readable decimal amount ("5" or "5.25") into a
 * wei-scale bigint using the token's decimals.
 *
 * Throws if the input has more fractional digits than `decimals`
 * supports — refuses to silently truncate precision. Callers should
 * validate + surface a precise error to the user before calling.
 */
export function parseAmountToWei(
  humanAmount: string,
  decimals: number,
): bigint {
  const trimmed = humanAmount.trim();
  if (!trimmed) {
    throw new Error("Amount is empty.");
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Amount "${humanAmount}" is not a non-negative decimal.`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount has ${frac.length} decimal places but token supports only ${decimals}.`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  // Using bigint arithmetic avoids Number-precision loss on large
  // amounts (USDC is 6 decimals, tolerable as Number but future
  // 18-decimal tokens would overflow).
  return BigInt(whole + padded);
}
