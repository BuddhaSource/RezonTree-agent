// vote-intent.ts — VoteIntent EIP-712 typed-data + POST body
// builders (loop 0068). Mirrors Commit (loop 0067) with
// allocationsHash replacing contentHash.
//
// Struct must match backend's internal/signer/vote_intent.go
// byte-for-byte:
//
//   VoteIntent(
//     bytes32 questionId,
//     address voter,
//     bytes32 allocationsHash,
//     uint256 feeAmount,
//     uint256 bondAmount,
//     uint256 nonce,
//     uint256 chainId,
//     uint256 expiresAt
//   )
//
// ─── ALLOCATIONS CANONICAL ENCODING ─────────────────────────────
//
// The backend + Router v2 accept `allocationsHash` as an opaque
// bytes32 — neither defines the "canonical allocations encoding"
// the hash preimage uses. This file is the first concrete
// implementation, so it ESTABLISHES that encoding for all future
// cross-language consumers (agent SDK, potential indexer
// recomputation, analytics).
//
// Canonical encoding, frozen here:
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
// follow these rules byte-for-byte. Pinned against a vector in
// tests/unit/vote-intent.test.ts to fence drift.
//
// R-CLIENT-IS-TRUST-ORIGIN — client hashes + signs; server never
// rewrites what the user agreed to.

import { keccak256, toBytes } from "viem";
import {
  buildRouterDomain,
  type RouterIntentDomain,
} from "./router-domain.js";
import type { VotePreflight } from "./preflight-types.js";

// ── Typed-data primitives ────────────────────────────────────────

export const VOTE_INTENT_TYPES = {
  VoteIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "voter", type: "address" },
    { name: "allocationsHash", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "bondAmount", type: "uint256" },
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
  bondAmount: bigint;
  nonce: bigint;
  chainId: bigint;
  expiresAt: bigint;
}

export interface VoteIntentTypedData {
  domain: RouterIntentDomain;
  types: typeof VOTE_INTENT_TYPES;
  primaryType: "VoteIntent";
  message: VoteIntentMessage;
}

export const DEFAULT_VOTE_TTL_SECONDS = 10 * 60;

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
 * allocations-encoding bytes. Pinned against a vector in the
 * test suite to lock the cross-language invariant.
 */
export function computeAllocationsHash(
  allocations: readonly Allocation[],
): `0x${string}` {
  const { bytes } = canonicalizeAllocations(allocations);
  return keccak256(bytes);
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
  feeWei?: bigint;
  bondWei?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): VoteIntentTypedData {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.expiresAtSeconds ?? now + DEFAULT_VOTE_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce_next);
  const fee = params.feeWei ?? BigInt(params.preflight.recommended_fee || "0");
  const bond =
    params.bondWei ?? BigInt(params.preflight.recommended_bond || "0");

  return {
    domain: buildRouterDomain({
      chainId: params.preflight.chain_id,
      routerAddress: params.preflight.router_address as `0x${string}`,
    }),
    types: VOTE_INTENT_TYPES,
    primaryType: "VoteIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      voter: params.voter,
      allocationsHash: params.allocationsHash,
      feeAmount: fee,
      bondAmount: bond,
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
// attack. Callers MUST send the same allocations the UI hashed +
// signed over; any divergence fails server-side validation with
// a teaching action.

export interface SubmitVoteIntentRequestBody {
  question_id: string;
  voter: string;
  allocations_hash: string;
  allocations: Allocation[];
  fee_amount: string;
  bond_amount: string;
  nonce: string;
  chain_id: string;
  expires_at: string;
  signature: string;
}

export function buildSubmitVoteIntentRequestBody(params: {
  typedData: VoteIntentTypedData;
  allocations: readonly Allocation[];
  signature: `0x${string}`;
}): SubmitVoteIntentRequestBody {
  const m = params.typedData.message;
  return {
    question_id: m.questionId,
    voter: m.voter,
    allocations_hash: m.allocationsHash,
    allocations: [...params.allocations],
    fee_amount: m.feeAmount.toString(),
    bond_amount: m.bondAmount.toString(),
    nonce: m.nonce.toString(),
    chain_id: m.chainId.toString(),
    expires_at: m.expiresAt.toString(),
    signature: params.signature,
  };
}
