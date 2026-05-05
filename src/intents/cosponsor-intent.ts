// cosponsor-intent.ts — CosponsorIntent EIP-712 builders for
// RezonForge v2.9.
//
// Signed by SUBSEQUENT contributors to an OPEN question. Per-Q
// parameters (oracle / token / floors / voteFee / feeShareBps /
// abandonmentGracePeriod) are inherited from chain state — the
// cosponsor doesn't re-state them. They DO sign their own per-
// contribution share array (each contributor independently chooses
// how to split their own share reserve).
//
// v2.9 change: per-intent feeShareBps REMOVED — the rate is now
// Q-level on the question state, frozen by the first sponsor.
//
// Pinned typehash (v2.9):
//   CosponsorIntent(bytes32 questionId,address sponsor,uint256 amount,
//     FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)
//   FeeShare(address recipient,uint256 basisPoints)
//   → 0xd9c03036132b2691bcf944f8964155d518856f9766727315bba50e72a9769dd4
//
// Mirrors contracts/src/RezonForge.sol's COSPONSOR_INTENT_TYPEHASH +
// internal/signer/cosponsor_intent.go +
// RezonTree-UI/lib/intents/cosponsor-intent.ts byte-for-byte.
//
// R-CHAIN-VERIFIES-INTENT — the signature is verified on-chain.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt mandatory.

import {
  buildForgeDomain,
  type ForgeIntentDomain,
} from "./forge-domain.js";
import { defaultFeeSharePolicy, type FeeShare } from "./fee-share.js";
import type { FundPreflight } from "./preflight-types.js";

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
    // v2.9: per-intent feeShareBps REMOVED (Q-level only).
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
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt =
    params.expiresAtSeconds ?? now + DEFAULT_COSPONSOR_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonceNext);

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
      // Chain rejects empty feeShares unconditionally. Auto-default to a
      // single self-recipient at 100% bps (matches sponsor/commit/vote).
      feeShares:
        params.feeShares ?? defaultFeeSharePolicy(params.sponsor).shares,
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
  funder: string;
  amount: string;
  nonce: string;
  chainId: string;
  expiresAt: string;
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
    funder: m.sponsor,
    amount: m.amount.toString(),
    nonce: m.nonce.toString(),
    chainId: m.chainId.toString(),
    expiresAt: m.expiresAt.toString(),
    signature: params.signature,
    feeShares: m.feeShares.map((s) => ({
      recipient: s.recipient,
      basisPoints: s.basisPoints.toString(),
    })),
  };
}
