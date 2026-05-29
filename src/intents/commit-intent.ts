// commit-intent.ts — CommitIntent EIP-712 typed-data + POST body
// builders.
//
// CommitIntent signs over a `contentHash`, NOT the content body.
// The body is POSTed separately to /v1/questions/:id/solutions; the
// backend asserts `keccak256(content) == intent.contentHash` to
// bind body to signature.
//
// The fee rate is Q-level (signed by the first sponsor, frozen for
// the question's lifetime); intents carry only the per-contribution
// `feeShares[]` recipient distribution, not the rate.
//
// 3-stack fence: contracts/src/RezonForge.sol's COMMIT_INTENT_TYPEHASH
// ↔ internal/signer/commit_intent.go ↔ this file. typehash.test.ts
// pins the literal hex against drift.
//
// R-CHAIN-VERIFIES-INTENT — RezonForge verifies this signature.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt mandatory + short.

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
import type { CommitPreflight } from "./preflight-types.js";
import {
  requireHexString,
  requireNonZeroNumber,
  requireString,
} from "./preflight-guards.js";

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

// 4 min — under the backend's MaxPermitTTL=5min ceiling (decision 0007)
// with 1min slack for clock skew + broadcast latency. Was 10min.
export const DEFAULT_COMMIT_TTL_SECONDS = 4 * 60;

// ── contentHash ──────────────────────────────────────────────────

/**
 * One competing branch a ReasoningNode weighed and rejected — the
 * shown probabilistic reasoning voters reward. Mirrors the backend's
 * domain.ReasoningAlternative (internal/domain/protocol.go).
 */
export interface ReasoningAlternative {
  therefore: string;
  confidence: number; // 0.0–1.0
  whyRejected: string;
}

/**
 * A single weighted node in the reasoning tree/DAG. Mirrors the
 * backend's domain.ReasoningNode (internal/domain/protocol.go): a
 * because→therefore inference plus the agent's confidence, the
 * competing branches it rejected (`alternatives`), and the ids of
 * downstream nodes it feeds (`children` — the edges that turn a flat
 * list into a DAG). `id` and `children`/`alternatives` are optional on
 * the wire; the backend synthesises sequential ids and wires legacy
 * linear chains when absent.
 */
export interface ReasoningNode {
  id?: string;
  because: string;
  therefore: string;
  confidence: number; // 0.0–1.0
  alternatives?: ReasoningAlternative[];
  children?: string[]; // ids of downstream nodes — makes it a DAG
}

/**
 * Structured solution body. Matches RezonTree-UI's SolutionBody and
 * the backend's CanonicalSolutionBody shape — same field names, same
 * order ({body, reasoningTree, claims}). The whole thing is hashed via
 * canonical JSON so the same input always yields the same digest across
 * stacks (UI / SDK / backend) regardless of object key insertion order.
 *
 * NOTE: there is no per-claim `references` field. References are a
 * separate top-level field on the CommitWitness (`references: string[]`),
 * a sibling to the solution body — not inside claims and not inside the
 * body JSON.
 */
export interface SolutionBody {
  body: string;
  reasoningTree: ReasoningNode[];
  claims: Array<{
    criterionId: string;
    value: unknown;
    argument: string;
    falsifiableBy: string;
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
  feeShares?: FeeShare[];
  feeAmount?: bigint;
  stakeAmount?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): CommitIntentTypedData {
  // Defensive null-checks — fail with an actionable error before
  // BigInt()/hexToBytes() blow up deep in the builder.
  requireHexString(params.preflight.qid, "qid");
  requireString(params.preflight.nonce, "nonce");
  requireNonZeroNumber(params.preflight.chainId, "chainId");
  requireString(params.preflight.forgeAddress, "forgeAddress");
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = params.expiresAtSeconds ?? now + DEFAULT_COMMIT_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce);
  const fee = params.feeAmount ?? BigInt(params.preflight.feeAmount || "0");
  const stake = params.stakeAmount ?? BigInt(params.preflight.stakeAmount || "0");

  // _validateFeeShareInvariants requires q.platformFeeRecipient to
  // appear in feeShares[]. Insert if absent (rebalances 90/10 by default).
  // The preflight advertises the value; refusing to sign without it
  // upholds R-CLIENT-IS-TRUST-ORIGIN.
  const baseShares =
    params.feeShares ?? defaultFeeSharePolicy(params.submitter).shares;
  const pfr = params.preflight.platformFeeRecipient as
    | `0x${string}`
    | undefined;
  const feeShares = pfr ? ensurePlatformFeeInShares(baseShares, pfr) : baseShares;

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chainId,
      forgeAddress: params.preflight.forgeAddress as `0x${string}`,
    }),
    types: COMMIT_INTENT_TYPES,
    primaryType: "CommitIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      submitter: params.submitter,
      contentHash: params.contentHash,
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
// Matches backend handler.SubmitCommitRequest
// (internal/handler/commit.go). All numerics are decimal strings;
// hex fields are 0x-prefixed.

export interface SubmitCommitRequestBody {
  questionId: string;
  submitter: string;
  contentHash: string;
  feeAmount: string;
  stakeAmount: string;
  feeShares: { recipient: string; basisPoints: string }[];
  nonce: string;
  chainId: number;
  expiresAt: number;
  signature: string;
}

export function buildSubmitCommitRequestBody(params: {
  typedData: CommitIntentTypedData;
  signature: `0x${string}`;
}): SubmitCommitRequestBody {
  const m = params.typedData.message;
  return {
    questionId: m.questionId,
    submitter: m.submitter,
    contentHash: m.contentHash,
    feeAmount: m.feeAmount.toString(),
    stakeAmount: m.stakeAmount.toString(),
    feeShares: m.feeShares.map((s) => ({
      recipient: s.recipient,
      basisPoints: s.basisPoints.toString(),
    })),
    nonce: m.nonce.toString(),
    chainId: Number(m.chainId),
    expiresAt: Number(m.expiresAt),
    signature: params.signature,
  };
}
