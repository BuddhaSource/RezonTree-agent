// vote-intent.ts — VoteIntent EIP-712 typed-data + POST body
// builders for RezonForge v2.5 (10-field — extends v2.4's 8-field
// shape with feeShareBps + feeShares).
//
// Pinned typehash:
//   VoteIntent(bytes32 questionId,address voter,bytes32 allocationsHash,
//     uint256 feeAmount,uint256 stakeAmount,uint256 feeShareBps,
//     FeeShare[] feeShares,uint256 nonce,uint256 chainId,
//     uint256 expiresAt)
//   FeeShare(address recipient,uint256 basisPoints)
//
// Mirrors contracts/src/RezonForge.sol's VOTE_INTENT_TYPEHASH +
// internal/signer/vote_intent.go +
// RezonTree-UI/lib/intents/vote-intent.ts byte-for-byte.
//
// ─── ALLOCATIONS CANONICAL ENCODING ─────────────────────────────
//
// The backend + RezonForge accept `allocationsHash` as an opaque
// bytes32 — neither defines the "canonical allocations encoding"
// the hash preimage uses. Encoding is frozen here:
//
//   1. Allocations are an array of {solution_id, points} objects.
//   2. Sort ASCENDING by solution_id (UTF-16 codepoint compare,
//      i.e. plain JS `[].sort()`; matches `sort.Strings` in Go).
//   3. Serialize as JSON with:
//      - double-quoted keys
//      - key order: solution_id, then points
//      - no whitespace (no indentation, no trailing spaces)
//   4. UTF-8-encode the resulting string.
//   5. keccak256 of those bytes → the 32-byte allocationsHash.
//
// Whoever recomputes the hash (backend audit, SDK, indexer) MUST
// follow these rules byte-for-byte. Pinned against a vector in the
// test suite to fence drift.
//
// R-CHAIN-VERIFIES-INTENT — RezonForge verifies this signature.
// R-CLIENT-IS-TRUST-ORIGIN — client hashes + signs; server never
// rewrites what the user agreed to.

import { keccak256, toBytes } from "viem";
import {
  buildForgeDomain,
  type ForgeIntentDomain,
} from "./forge-domain.js";
import { defaultFeeSharePolicy, type FeeShare } from "./fee-share.js";
import type { VotePreflight } from "./preflight-types.js";

// ── Typed-data primitives ────────────────────────────────────────

export const VOTE_INTENT_TYPES = {
  FeeShare: [
    { name: "recipient", type: "address" },
    { name: "basisPoints", type: "uint256" },
  ],
  VoteIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "voter", type: "address" },
    { name: "allocationsHash", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "stakeAmount", type: "uint256" },
    { name: "feeShareBps", type: "uint256" },
    { name: "feeShares", type: "FeeShare[]" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface VoteIntentMessage {
  questionId: `0x${string}`;
  voter: `0x${string}`;
  allocationsHash: `0x${string}`;
  feeAmount: bigint;
  stakeAmount: bigint;
  feeShareBps: bigint;
  feeShares: FeeShare[];
  nonce: bigint;
  chainId: bigint;
  expiresAt: bigint;
}

export interface VoteIntentTypedData {
  domain: ForgeIntentDomain;
  types: typeof VOTE_INTENT_TYPES;
  primaryType: "VoteIntent";
  message: VoteIntentMessage;
}

// 4 min — under the backend's MaxPermitTTL=5min ceiling (decision 0007)
// with 1min slack for clock skew + broadcast latency. Was 10min.
export const DEFAULT_VOTE_TTL_SECONDS = 4 * 60;

// ── Allocations canonical form ──────────────────────────────────

/** One allocation entry. `points` must be a non-negative integer. */
export interface Allocation {
  solution_id: string;
  points: number;
}

/**
 * Canonicalizes an allocations list: sorted by solution_id ASC,
 * minified-JSON serialized with `solution_id`-then-`points` key
 * order, UTF-8 encoded.
 *
 * Returns the canonical string (for inspection + debug display)
 * alongside the bytes, so `computeAllocationsHash` composes
 * without re-running the sort.
 */
export function canonicalizeAllocations(allocations: readonly Allocation[]): {
  json: string;
  bytes: Uint8Array;
} {
  const sorted = [...allocations].sort((a, b) =>
    a.solution_id < b.solution_id ? -1 : a.solution_id > b.solution_id ? 1 : 0,
  );
  // Build the JSON by hand so we control key order + whitespace
  // (JSON.stringify with a replacer doesn't guarantee key order
  // on all JS engines, and formatting differs between
  // implementations).
  const parts = sorted.map(
    (a) =>
      `{"solution_id":${JSON.stringify(a.solution_id)},"points":${a.points}}`,
  );
  const json = `[${parts.join(",")}]`;
  return { json, bytes: new TextEncoder().encode(json) };
}

/**
 * Computes the allocationsHash: keccak256 of the canonical
 * allocations-encoding bytes followed by the 32-byte server-issued
 * salt. Without the salt the hash would be enumerable from public
 * protocol parameters (number of solutions × point grid) — an
 * attacker watching VoteCast events on chain could rainbow-table
 * the voter's specific allocation. The salt is fetched from the
 * vote-preflight response and echoed back in the POST body; the
 * backend HMAC-verifies it before recomputing this hash.
 *
 * Salt MUST be 32 bytes (64 hex chars + 0x prefix). Mismatching
 * length would silently produce a different hash than backend
 * recomputation.
 */
export function computeAllocationsHash(
  allocations: readonly Allocation[],
  salt: `0x${string}`,
): `0x${string}` {
  const { bytes: canon } = canonicalizeAllocations(allocations);
  const saltBytes = hexToBytes(salt);
  if (saltBytes.length !== 32) {
    throw new Error(
      `vote salt must be 32 bytes; got ${saltBytes.length} (hex=${salt})`,
    );
  }
  const buf = new Uint8Array(canon.length + saltBytes.length);
  buf.set(canon, 0);
  buf.set(saltBytes, canon.length);
  return keccak256(buf);
}

/** 0x-prefixed hex string → byte array. Errors on odd-length or
 *  non-hex input so a typo can't silently produce a different salt
 *  than the backend will use. */
function hexToBytes(hex: string): Uint8Array {
  if (!hex.startsWith("0x")) {
    throw new Error(`expected 0x-prefixed hex, got ${hex}`);
  }
  const body = hex.slice(2);
  if (body.length % 2 !== 0) {
    throw new Error(`hex must have even length, got ${body}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex character in ${hex}`);
    }
    out[i] = byte;
  }
  return out;
}

// Validates that every allocation is a non-negative integer with
// a non-empty solution_id — refuses inputs that would encode
// identically but differ after normalization (e.g. a fractional
// points value silently truncated by JSON).
export function validateAllocations(allocations: readonly Allocation[]): void {
  for (const a of allocations) {
    if (!a.solution_id || typeof a.solution_id !== "string") {
      throw new Error(
        `Allocation has empty or non-string solution_id: ${JSON.stringify(a)}`,
      );
    }
    if (!Number.isInteger(a.points) || a.points < 0) {
      throw new Error(
        `Allocation points must be a non-negative integer, got ${a.points} for ${a.solution_id}`,
      );
    }
  }
  const ids = allocations.map((a) => a.solution_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Allocations contain duplicate solution_id entries");
  }
}

// ── Builder ──────────────────────────────────────────────────────

export function buildVoteIntentTypedData(params: {
  preflight: VotePreflight;
  voter: `0x${string}`;
  allocationsHash: `0x${string}`;
  feeShareBps?: bigint;
  feeShares?: FeeShare[];
  feeWei?: bigint;
  stakeWei?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): VoteIntentTypedData {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.expiresAtSeconds ?? now + DEFAULT_VOTE_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce_next);
  const fee = params.feeWei ?? BigInt(params.preflight.fee || "0");
  const stake = params.stakeWei ?? BigInt(params.preflight.stake || "0");

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chain_id,
      forgeAddress: params.preflight.forge_address as `0x${string}`,
    }),
    types: VOTE_INTENT_TYPES,
    primaryType: "VoteIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      voter: params.voter,
      allocationsHash: params.allocationsHash,
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
        params.feeShares ?? defaultFeeSharePolicy(params.voter).shares,
      nonce,
      chainId: BigInt(params.preflight.chain_id),
      expiresAt: BigInt(ttl),
    },
  };
}

// ── POST body shape ──────────────────────────────────────────────
// Matches backend handler.SubmitVoteIntentRequest.
//
// Loop 0072 (decision 0005 §C): the `allocations` array rides
// alongside the `allocations_hash`. The backend recomputes the
// canonical-form hash from `allocations` and rejects on mismatch,
// preventing the sign-hash-but-display-different-data class of
// attack.

export interface SubmitVoteIntentRequestBody {
  question_id: string;
  voter: string;
  allocations_hash: string;
  allocations: Allocation[];
  fee_amount: string;
  stake_amount: string;
  fee_share_bps: string;
  fee_shares: { recipient: string; basis_points: string }[];
  nonce: string;
  chain_id: string;
  expires_at: string;
  signature: string;
  // Salt + saltToken come from the vote-preflight response. The
  // backend HMAC-verifies the token at submit time and rejects any
  // substitute or expired pair, defeating downgrade-the-salt attacks.
  vote_salt: string;
  vote_salt_token: string;
}

export function buildSubmitVoteIntentRequestBody(params: {
  typedData: VoteIntentTypedData;
  allocations: readonly Allocation[];
  signature: `0x${string}`;
  voteSalt: `0x${string}`;
  voteSaltToken: `0x${string}`;
}): SubmitVoteIntentRequestBody {
  const m = params.typedData.message;
  return {
    question_id: m.questionId,
    voter: m.voter,
    allocations_hash: m.allocationsHash,
    allocations: [...params.allocations],
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
    vote_salt: params.voteSalt,
    vote_salt_token: params.voteSaltToken,
  };
}
