// cosponsor-intent.ts — CosponsorIntent EIP-712 builders for
// RezonForge v2.5.
//
// Signed by SUBSEQUENT contributors to an OPEN question. Per-Q
// parameters (oracle / token / floors / voteFee /
// abandonmentGracePeriod) are inherited from chain state — the
// cosponsor doesn't re-state them. They DO sign their own per-
// contribution share array (each contributor independently chooses
// how to split their own share reserve).
//
// Pinned typehash (cosponsor):
//   CosponsorIntent(bytes32 questionId,address sponsor,uint256 amount,
//     uint256 feeShareBps,FeeShare[] feeShares,uint256 nonce,
//     uint256 chainId,uint256 expiresAt)
//   FeeShare(address recipient,uint256 basisPoints)
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
import type { FeeShare } from "./fee-share.js";
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
    { name: "feeShareBps", type: "uint256" },
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
  feeShareBps: bigint;
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

export const DEFAULT_COSPONSOR_TTL_SECONDS = 10 * 60;

// ── Builder ──────────────────────────────────────────────────────

export function buildCosponsorIntentTypedData(params: {
  preflight: FundPreflight;
  sponsor: `0x${string}`;
  amountWei: bigint;
  feeShareBps: bigint;
  feeShares: FeeShare[];
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): CosponsorIntentTypedData {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt =
    params.expiresAtSeconds ?? now + DEFAULT_COSPONSOR_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce_next);

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chain_id,
      forgeAddress: params.preflight.forge_address as `0x${string}`,
    }),
    types: COSPONSOR_INTENT_TYPES,
    primaryType: "CosponsorIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      sponsor: params.sponsor,
      amount: params.amountWei,
      feeShareBps: params.feeShareBps,
      feeShares: params.feeShares,
      nonce,
      chainId: BigInt(params.preflight.chain_id),
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
  question_id: string;
  funder: string;
  amount: string;
  nonce: string;
  chain_id: string;
  expires_at: string;
  signature: string;
  fee_share_bps: string;
  fee_shares: { recipient: string; basis_points: string }[];
}

export function buildCosponsorFundRequestBody(params: {
  typedData: CosponsorIntentTypedData;
  signature: `0x${string}`;
}): CosponsorFundRequestBody {
  const m = params.typedData.message;
  return {
    mode: "cosponsor",
    question_id: m.questionId,
    funder: m.sponsor,
    amount: m.amount.toString(),
    nonce: m.nonce.toString(),
    chain_id: m.chainId.toString(),
    expires_at: m.expiresAt.toString(),
    signature: params.signature,
    fee_share_bps: m.feeShareBps.toString(),
    fee_shares: m.feeShares.map((s) => ({
      recipient: s.recipient,
      basis_points: s.basisPoints.toString(),
    })),
  };
}
