// commit-intent.ts — CommitIntent EIP-712 typed-data + POST body
// builders for RezonForge v2.5 (10-field — extends v2.4's 8-field
// shape with feeShareBps + feeShares per migration 043).
//
// CommitIntent signs over a `contentHash`, NOT the content body.
// The body is POSTed separately to /v1/problems/:id/solutions; the
// backend asserts `keccak256(content) == intent.contentHash` to
// bind body to signature.
//
// Pinned typehash:
//   CommitIntent(bytes32 questionId,address submitter,bytes32 contentHash,
//     uint256 feeAmount,uint256 bondAmount,uint256 feeShareBps,
//     FeeShare[] feeShares,uint256 nonce,uint256 chainId,
//     uint256 expiresAt)
//   FeeShare(address recipient,uint256 basisPoints)
//
// Mirrors contracts/src/RezonForge.sol's COMMIT_INTENT_TYPEHASH +
// internal/signer/commit_intent.go +
// RezonTree-UI/lib/intents/commit-intent.ts byte-for-byte.
//
// R-CHAIN-VERIFIES-INTENT — RezonForge verifies this signature.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt mandatory + short.

import { keccak256, toBytes } from "viem";
import {
  buildForgeDomain,
  type ForgeIntentDomain,
} from "./forge-domain.js";
import type { FeeShare } from "./fee-share.js";
import type { CommitPreflight } from "./preflight-types.js";

// ── Typed-data primitives ────────────────────────────────────────

export const COMMIT_INTENT_TYPES = {
  FeeShare: [
    { name: "recipient", type: "address" },
    { name: "basisPoints", type: "uint256" },
  ],
  CommitIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "submitter", type: "address" },
    { name: "contentHash", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "bondAmount", type: "uint256" },
    { name: "feeShareBps", type: "uint256" },
    { name: "feeShares", type: "FeeShare[]" },
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
  feeShareBps: bigint;
  feeShares: FeeShare[];
  nonce: bigint;
  chainId: bigint;
  expiresAt: bigint;
}

export interface CommitIntentTypedData {
  domain: ForgeIntentDomain;
  types: typeof COMMIT_INTENT_TYPES;
  primaryType: "CommitIntent";
  message: CommitIntentMessage;
}

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
  feeShareBps: bigint;
  feeShares: FeeShare[];
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
    domain: buildForgeDomain({
      chainId: params.preflight.chain_id,
      forgeAddress: params.preflight.forge_address as `0x${string}`,
    }),
    types: COMMIT_INTENT_TYPES,
    primaryType: "CommitIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      submitter: params.submitter,
      contentHash: params.contentHash,
      feeAmount: fee,
      bondAmount: bond,
      feeShareBps: params.feeShareBps,
      feeShares: params.feeShares,
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
  fee_share_bps: string;
  fee_shares: { recipient: string; basis_points: string }[];
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
    fee_share_bps: m.feeShareBps.toString(),
    fee_shares: m.feeShares.map((s) => ({
      recipient: s.recipient,
      basis_points: s.basisPoints.toString(),
    })),
    nonce: m.nonce.toString(),
    chain_id: m.chainId.toString(),
    expires_at: m.expiresAt.toString(),
    signature: params.signature,
  };
}
