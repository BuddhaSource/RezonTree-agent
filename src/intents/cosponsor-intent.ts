// cosponsor-intent.ts — CosponsorIntent EIP-712 builders.
//
// Signed by SUBSEQUENT contributors to an OPEN question. Per-Q
// parameters (oracle / token / floors / voteFee / feeShareBps /
// abandonmentGracePeriod / fundingDeadline) are inherited from chain
// state — the cosponsor doesn't re-state them. They DO sign their
// own per-contribution share array (each contributor independently
// chooses how to split their own share reserve).
//
// 3-stack fence: contracts/src/RezonForge.sol's COSPONSOR_INTENT_TYPEHASH
// ↔ internal/signer/cosponsor_intent.go ↔ this file. typehash.test.ts
// pins the literal hex against drift.
//
// R-CHAIN-VERIFIES-INTENT — the signature is verified on-chain.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt mandatory.

import {
  buildForgeDomain,
  type ForgeIntentDomain,
} from "./forge-domain.js";
import {
  defaultFeeSharePolicy,
  ensurePlatformFeeInShares,
  type FeeShare,
} from "./fee-share.js";
import type { FundPreflight } from "./preflight-types.js";
import {
  requireHexString,
  requireNonZeroNumber,
  requireString,
} from "./preflight-guards.js";

// ── Typed-data primitives ────────────────────────────────────────

export const COSPONSOR_INTENT_TYPES = {
  FeeShare: [
    { name: "recipient", type: "address" },
    { name: "basisPoints", type: "uint256" },
  ],
  CosponsorIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "sponsor", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "feeShares", type: "FeeShare[]" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface CosponsorIntentMessage {
  questionId: `0x${string}`;
  // The struct field is named `sponsor` (matching the Solidity struct);
  // it's the cosponsor's wallet — the sponsor of THIS contribution.
  sponsor: `0x${string}`;
  amount: bigint;
  feeShares: FeeShare[];
  nonce: bigint;
  chainId: bigint;
  expiresAt: bigint;
}

export interface CosponsorIntentTypedData {
  domain: ForgeIntentDomain;
  types: typeof COSPONSOR_INTENT_TYPES;
  primaryType: "CosponsorIntent";
  message: CosponsorIntentMessage;
}

// 4 min — must stay under backend MaxPermitTTL ceiling of 5 min.
export const DEFAULT_COSPONSOR_TTL_SECONDS = 4 * 60;

// ── Builder ──────────────────────────────────────────────────────

export function buildCosponsorIntentTypedData(params: {
  preflight: FundPreflight;
  sponsor: `0x${string}`;
  amountWei: bigint;
  feeShares?: FeeShare[];
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): CosponsorIntentTypedData {
  // Defensive null-checks — fail with an actionable error before
  // BigInt()/hexToBytes() blow up deep in the builder.
  requireHexString(params.preflight.qid, "qid");
  requireString(params.preflight.nonce, "nonce");
  requireNonZeroNumber(params.preflight.chainId, "chainId");
  requireString(params.preflight.forgeAddress, "forgeAddress");
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt =
    params.expiresAtSeconds ?? now + DEFAULT_COSPONSOR_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce);

  // _validateFeeShareInvariants requires q.platformFeeRecipient to
  // appear in feeShares[]. Cosponsor preflight advertises the value.
  const baseShares =
    params.feeShares ?? defaultFeeSharePolicy(params.sponsor).shares;
  const pfr = params.preflight.platformFeeRecipient as
    | `0x${string}`
    | undefined;
  const feeShares = pfr ? ensurePlatformFeeInShares(baseShares, pfr) : baseShares;

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chainId,
      forgeAddress: params.preflight.forgeAddress as `0x${string}`,
    }),
    types: COSPONSOR_INTENT_TYPES,
    primaryType: "CosponsorIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      sponsor: params.sponsor,
      amount: params.amountWei,
      feeShares,
      nonce,
      chainId: BigInt(params.preflight.chainId),
      expiresAt: BigInt(expiresAt),
    },
  };
}

// ── POST body shape ──────────────────────────────────────────────
// Mirrors RezonTree-UI/lib/intents/cosponsor-intent.ts. Sponsor-only
// fields are explicitly omitted — backend's parseFundJoinRequest
// rejects the request if any sponsor-only field is present.

export interface CosponsorFundRequestBody {
  mode: "cosponsor";
  questionId: string;
  sponsor: string;
  amount: string;
  nonce: string;
  chainId: number;
  expiresAt: number;
  signature: string;
  feeShares: { recipient: string; basisPoints: string }[];
}

export function buildCosponsorFundRequestBody(params: {
  typedData: CosponsorIntentTypedData;
  signature: `0x${string}`;
}): CosponsorFundRequestBody {
  const m = params.typedData.message;
  return {
    mode: "cosponsor",
    questionId: m.questionId,
    sponsor: m.sponsor,
    amount: m.amount.toString(),
    nonce: m.nonce.toString(),
    chainId: Number(m.chainId),
    expiresAt: Number(m.expiresAt),
    signature: params.signature,
    feeShares: m.feeShares.map((s) => ({
      recipient: s.recipient,
      basisPoints: s.basisPoints.toString(),
    })),
  };
}
