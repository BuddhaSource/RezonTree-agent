// vote-intent.ts — VoteIntent EIP-712 typed-data + POST body
// builders.
//
// The fee rate is Q-level (signed by the first sponsor, frozen for
// the question's lifetime); intents carry only the per-contribution
// `feeShares[]` recipient distribution, not the rate.
//
// 3-stack fence: contracts/src/RezonForge.sol's VOTE_INTENT_TYPEHASH ↔
// internal/signer/vote_intent.go ↔ this file. typehash.test.ts pins
// the literal hex against drift.
//
// ─── ALLOCATIONS CANONICAL ENCODING ─────────────────────────────
//
// The backend + RezonForge accept `allocationsHash` as an opaque
// bytes32 — neither defines the "canonical allocations encoding"
// the hash preimage uses. Encoding is frozen here:
//
//   1. Allocations are an array of {solutionId, points} objects.
//   2. Sort ASCENDING by solutionId (UTF-16 codepoint compare,
//      i.e. plain JS `[].sort()`; matches `sort.Strings` in Go).
//   3. Serialize as JSON with:
//      - double-quoted keys
//      - key order: solutionId, then points
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
import {
  defaultFeeSharePolicy,
  ensurePlatformFeeInShares,
  type FeeShare,
} from "./fee-share.js";
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
  solutionId: string;
  points: number;
}

/**
 * Canonicalizes an allocations list: sorted by solutionId ASC,
 * minified-JSON serialized with `solutionId`-then-`points` key
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
    a.solutionId < b.solutionId ? -1 : a.solutionId > b.solutionId ? 1 : 0,
  );
  // Build the JSON by hand so we control key order + whitespace
  // (JSON.stringify with a replacer doesn't guarantee key order
  // on all JS engines, and formatting differs between
  // implementations).
  const parts = sorted.map(
    (a) =>
      `{"solutionId":${JSON.stringify(a.solutionId)},"points":${a.points}}`,
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
// a non-empty solutionId — refuses inputs that would encode
// identically but differ after normalization (e.g. a fractional
// points value silently truncated by JSON).
export function validateAllocations(allocations: readonly Allocation[]): void {
  for (const a of allocations) {
    if (!a.solutionId || typeof a.solutionId !== "string") {
      throw new Error(
        `Allocation has empty or non-string solutionId: ${JSON.stringify(a)}`,
      );
    }
    if (!Number.isInteger(a.points) || a.points < 0) {
      throw new Error(
        `Allocation points must be a non-negative integer, got ${a.points} for ${a.solutionId}`,
      );
    }
  }
  const ids = allocations.map((a) => a.solutionId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Allocations contain duplicate solutionId entries");
  }
}

// ── Builder ──────────────────────────────────────────────────────

export function buildVoteIntentTypedData(params: {
  preflight: VotePreflight;
  voter: `0x${string}`;
  allocationsHash: `0x${string}`;
  feeShares?: FeeShare[];
  feeAmount?: bigint;
  stakeAmount?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): VoteIntentTypedData {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.expiresAtSeconds ?? now + DEFAULT_VOTE_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce);
  const fee = params.feeAmount ?? BigInt(params.preflight.feeAmount || "0");
  const stake = params.stakeAmount ?? BigInt(params.preflight.stakeAmount || "0");

  // _validateFeeShareInvariants requires q.platformFeeRecipient to
  // appear in feeShares[]. The preflight advertises the value.
  const baseShares =
    params.feeShares ?? defaultFeeSharePolicy(params.voter).shares;
  const pfr = params.preflight.platformFeeRecipient as
    | `0x${string}`
    | undefined;
  const feeShares = pfr ? ensurePlatformFeeInShares(baseShares, pfr) : baseShares;

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chainId,
      forgeAddress: params.preflight.forgeAddress as `0x${string}`,
    }),
    types: VOTE_INTENT_TYPES,
    primaryType: "VoteIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      voter: params.voter,
      allocationsHash: params.allocationsHash,
      feeAmount: fee,
      stakeAmount: stake,
      feeShares,
      nonce,
      chainId: BigInt(params.preflight.chainId),
      expiresAt: BigInt(ttl),
    },
  };
}

// ── POST body shape ──────────────────────────────────────────────
// Matches backend handler.SubmitVoteIntentRequest.
//
// The `allocations` array rides alongside the `allocations_hash`
// (decision 0005 §C). The backend recomputes the canonical-form
// hash from `allocations` and rejects on mismatch, preventing the
// sign-hash-but-display-different-data class of attack.

export interface SubmitVoteIntentRequestBody {
  questionId: string;
  voter: string;
  allocationsHash: string;
  allocations: Allocation[];
  feeAmount: string;
  stakeAmount: string;
  feeShares: { recipient: string; basisPoints: string }[];
  nonce: string;
  chainId: string;
  expiresAt: string;
  signature: string;
  // Salt + saltToken come from the vote-preflight response. The
  // backend HMAC-verifies the token at submit time and rejects any
  // substitute or expired pair, defeating downgrade-the-salt attacks.
  voteSalt: string;
  voteSaltToken: string;
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
    questionId: m.questionId,
    voter: m.voter,
    allocationsHash: m.allocationsHash,
    allocations: [...params.allocations],
    feeAmount: m.feeAmount.toString(),
    stakeAmount: m.stakeAmount.toString(),
    feeShares: m.feeShares.map((s) => ({
      recipient: s.recipient,
      basisPoints: s.basisPoints.toString(),
    })),
    nonce: m.nonce.toString(),
    chainId: m.chainId.toString(),
    expiresAt: m.expiresAt.toString(),
    signature: params.signature,
    voteSalt: params.voteSalt,
    voteSaltToken: params.voteSaltToken,
  };
}
