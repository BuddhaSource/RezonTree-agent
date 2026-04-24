// commit-intent.ts — CommitIntent EIP-712 typed-data + POST body
// builders (loop 0067). Mirrors the Fund primitive (loop 0066)
// with the added wrinkle that CommitIntent signs over a
// `contentHash`, not the content itself. The solution body is
// never signed — only its keccak256. The backend separately
// asserts `keccak256(content) == intent.contentHash` on the
// relevant content-submission path.
//
// Struct must match backend's internal/signer/commit_intent.go
// byte-for-byte:
//
//   CommitIntent(
//     bytes32 questionId,
//     address submitter,
//     bytes32 contentHash,
//     uint256 feeAmount,
//     uint256 bondAmount,
//     uint256 nonce,
//     uint256 chainId,
//     uint256 expiresAt
//   )
//
// Any drift → RouterBadSigner on-chain. Treat as schema contract.
//
// R-CHAIN-VERIFIES-INTENT — Router v2 verifies this signature.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt mandatory + short.

import { keccak256, toBytes } from "viem";
import {
  buildRouterDomain,
  type RouterIntentDomain,
} from "./router-domain.js";
import type { CommitPreflight } from "./preflight-types.js";

// ── Typed-data primitives ────────────────────────────────────────

export const COMMIT_INTENT_TYPES = {
  CommitIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "submitter", type: "address" },
    { name: "contentHash", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "bondAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface CommitIntentMessage {
  questionId: `0x${string}`;
  submitter: `0x${string}`;
  contentHash: `0x${string}`;
  feeAmount: bigint;
  bondAmount: bigint;
  nonce: bigint;
  chainId: bigint;
  expiresAt: bigint;
}

export interface CommitIntentTypedData {
  domain: RouterIntentDomain;
  types: typeof COMMIT_INTENT_TYPES;
  primaryType: "CommitIntent";
  message: CommitIntentMessage;
}

// ── TTL policy (shared with Fund) ────────────────────────────────
export const DEFAULT_COMMIT_TTL_SECONDS = 10 * 60;

// ── contentHash ──────────────────────────────────────────────────

/**
 * Computes the on-chain-canonical content hash for a solution body.
 * keccak256 over UTF-8 bytes — matches backend's expectation where
 * the content is stored as raw bytes and hashed identically.
 *
 * The hash is what gets signed; the body itself is posted separately
 * via the solutions endpoint. Keeping the hash + sign deterministic
 * on the client means a compromised server can't silently rewrite
 * what the user agreed to submit.
 */
export function computeContentHash(body: string): `0x${string}` {
  return keccak256(toBytes(body));
}

// ── Builder ──────────────────────────────────────────────────────

export function buildCommitIntentTypedData(params: {
  preflight: CommitPreflight;
  submitter: `0x${string}`;
  contentHash: `0x${string}`;
  feeWei?: bigint;
  bondWei?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): CommitIntentTypedData {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.expiresAtSeconds ?? now + DEFAULT_COMMIT_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce_next);
  const fee = params.feeWei ?? BigInt(params.preflight.recommended_fee || "0");
  const bond =
    params.bondWei ?? BigInt(params.preflight.recommended_bond || "0");

  return {
    domain: buildRouterDomain({
      chainId: params.preflight.chain_id,
      routerAddress: params.preflight.router_address as `0x${string}`,
    }),
    types: COMMIT_INTENT_TYPES,
    primaryType: "CommitIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      submitter: params.submitter,
      contentHash: params.contentHash,
      feeAmount: fee,
      bondAmount: bond,
      nonce,
      chainId: BigInt(params.preflight.chain_id),
      expiresAt: BigInt(ttl),
    },
  };
}

// ── POST body shape ──────────────────────────────────────────────
// Matches backend handler.SubmitCommitRequest
// (internal/handler/commit.go). All numerics are decimal strings;
// hex fields are 0x-prefixed.

export interface SubmitCommitRequestBody {
  question_id: string;
  submitter: string;
  content_hash: string;
  fee_amount: string;
  bond_amount: string;
  nonce: string;
  chain_id: string;
  expires_at: string;
  signature: string;
}

export function buildSubmitCommitRequestBody(params: {
  typedData: CommitIntentTypedData;
  signature: `0x${string}`;
}): SubmitCommitRequestBody {
  const m = params.typedData.message;
  return {
    question_id: m.questionId,
    submitter: m.submitter,
    content_hash: m.contentHash,
    fee_amount: m.feeAmount.toString(),
    bond_amount: m.bondAmount.toString(),
    nonce: m.nonce.toString(),
    chain_id: m.chainId.toString(),
    expires_at: m.expiresAt.toString(),
    signature: params.signature,
  };
}
