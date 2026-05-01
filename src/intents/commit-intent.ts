// commit-intent.ts — CommitIntent EIP-712 typed-data + POST body
// builders for RezonForge v2.5 (10-field — extends v2.4's 8-field
// shape with feeShareBps + feeShares per migration 043).
//
// CommitIntent signs over a `contentHash`, NOT the content body.
// The body is POSTed separately to /v1/questions/:id/solutions; the
// backend asserts `keccak256(content) == intent.contentHash` to
// bind body to signature.
//
// Pinned typehash:
//   CommitIntent(bytes32 questionId,address submitter,bytes32 contentHash,
//     uint256 feeAmount,uint256 stakeAmount,uint256 feeShareBps,
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
import { defaultFeeSharePolicy, type FeeShare } from "./fee-share.js";
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
    { name: "stakeAmount", type: "uint256" },
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
  stakeAmount: bigint;
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
 * Structured solution body. Matches RezonTree-UI's SolutionBody and
 * the backend's `solutionBodyForHash` shape — same field names, same
 * order. The whole thing is hashed via canonical JSON so the same
 * input always yields the same digest across stacks (UI / SDK /
 * backend) regardless of object key insertion order.
 */
export interface SolutionBody {
  body: string;
  reasoning_tree: Array<{ because: string; therefore: string }>;
  claims: Array<{
    criterion_id: string;
    value: unknown;
    argument: string;
    falsifiable_by: string;
  }>;
}

/**
 * canonicalStringify produces a deterministic JSON encoding suitable
 * for cross-engine hashing. Object keys are sorted; arrays preserve
 * order; `undefined` properties are omitted; non-finite numbers /
 * bigints are rejected (JSON.stringify silently emits NaN as `null`,
 * which would corrupt the hash).
 *
 * J3 (audit 2026-04-30): plain JSON.stringify is insertion-order on
 * the SDK side and struct-declaration order on the backend; if any
 * caller shuffles keys, the two hashes drift. Sorted-key serialization
 * eliminates that surface.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) {
    throw new Error("canonicalStringify: undefined is not encodable");
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `canonicalStringify: non-finite number ${value} is not encodable`,
        );
      }
      return JSON.stringify(value);
    case "bigint":
      throw new Error("canonicalStringify: bigint is not encodable");
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(
        `canonicalStringify: unsupported type ${typeof value}`,
      );
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * Computes the canonical content hash for a solution body. Accepts
 * either a structured SolutionBody (preferred — matches the UI +
 * backend wire shape) or a pre-stringified body string for legacy
 * callers (battle harness solution-body.ts that fixtures plain
 * markdown). String inputs are hashed as-is to preserve back-compat;
 * object inputs go through canonicalStringify first.
 */
export function computeContentHash(
  body: SolutionBody | string,
): `0x${string}` {
  const encoded =
    typeof body === "string" ? body : canonicalStringify(body);
  return keccak256(toBytes(encoded));
}

// ── Builder ──────────────────────────────────────────────────────

export function buildCommitIntentTypedData(params: {
  preflight: CommitPreflight;
  submitter: `0x${string}`;
  contentHash: `0x${string}`;
  feeShareBps?: bigint;
  feeShares?: FeeShare[];
  feeWei?: bigint;
  stakeWei?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): CommitIntentTypedData {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.expiresAtSeconds ?? now + DEFAULT_COMMIT_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce_next);
  const fee = params.feeWei ?? BigInt(params.preflight.recommended_fee || "0");
  const stake =
    params.stakeWei ?? BigInt(params.preflight.recommended_stake || "0");

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
      stakeAmount: stake,
      feeShareBps: params.feeShareBps ?? 0n,
      // Chain rejects empty fee_shares regardless of feeShareBps. Reuse
      // defaultFeeSharePolicy's shares list (single self-recipient at
      // 10000 bps) so the chain-valid minimum has one definition. We
      // keep our own bps default at 0n (vs the policy's 1n) — the
      // policy's bps is a separate knob; the shares array is the part
      // shared.
      feeShares:
        params.feeShares ?? defaultFeeSharePolicy(params.submitter).shares,
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
  stake_amount: string;
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
    stake_amount: m.stakeAmount.toString(),
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
