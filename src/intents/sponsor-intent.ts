// sponsor-intent.ts — SponsorIntent EIP-712 builders for RezonForge v2.5.
//
// Signed by the FIRST sponsor of a question. Carries the full per-Q
// parameter set (oracle / token / floors / voteFee / abandonmentGrace)
// that the chain pins on first contact; subsequent contributors use
// CosponsorIntent (cosponsor-intent.ts) and inherit those params from
// chain state.
//
// 3-stack fence: Solidity (contracts/src/RezonForge.sol) ↔ Go
// (internal/signer/sponsor_intent.go) ↔ TS (this file +
// RezonTree-UI/lib/intents/sponsor-intent.ts). Any drift surfaces as
// a bad-signer revert on chain.
//
// Pinned typehash (sponsor):
//   SponsorIntent(bytes32 questionId,address oracle,address token,
//     uint256 minBondFloor,uint256 bondBasisPoints,uint256 minSponsorship,
//     uint256 voteFee,uint256 abandonmentGracePeriod,address sponsor,
//     uint256 amount,uint256 feeShareBps,FeeShare[] feeShares,
//     uint256 nonce,uint256 chainId,uint256 expiresAt)
//   FeeShare(address recipient,uint256 basisPoints)
//
// R-CHAIN-VERIFIES-INTENT — the signature is verified on-chain.
// R-CLIENT-IS-TRUST-ORIGIN — client constructs from advertised params.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt is mandatory and short.

import {
  buildForgeDomain,
  type ForgeIntentDomain,
} from "./forge-domain.js";
import type { FeeShare } from "./fee-share.js";
import type { FundPreflight } from "./preflight-types.js";

// ── Typed-data primitives ────────────────────────────────────────

export const SPONSOR_INTENT_TYPES = {
  FeeShare: [
    { name: "recipient", type: "address" },
    { name: "basisPoints", type: "uint256" },
  ],
  SponsorIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "oracle", type: "address" },
    { name: "token", type: "address" },
    { name: "minBondFloor", type: "uint256" },
    { name: "bondBasisPoints", type: "uint256" },
    { name: "minSponsorship", type: "uint256" },
    { name: "voteFee", type: "uint256" },
    { name: "abandonmentGracePeriod", type: "uint256" },
    { name: "sponsor", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "feeShareBps", type: "uint256" },
    { name: "feeShares", type: "FeeShare[]" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface SponsorIntentMessage {
  questionId: `0x${string}`;
  oracle: `0x${string}`;
  token: `0x${string}`;
  minBondFloor: bigint;
  bondBasisPoints: bigint;
  minSponsorship: bigint;
  voteFee: bigint;
  abandonmentGracePeriod: bigint;
  sponsor: `0x${string}`;
  amount: bigint;
  feeShareBps: bigint;
  feeShares: FeeShare[];
  nonce: bigint;
  chainId: bigint;
  expiresAt: bigint;
}

export interface SponsorIntentTypedData {
  domain: ForgeIntentDomain;
  types: typeof SPONSOR_INTENT_TYPES;
  primaryType: "SponsorIntent";
  message: SponsorIntentMessage;
}

// ── TTL policy ───────────────────────────────────────────────────
// R-INTENT-CARRIES-EXPIRY: every signed intent declares its own
// TTL. 10 minutes is the default — past wallet-prompt + broadcast
// latency, well under the backend's MaxPermitTTL of 15 min.
export const DEFAULT_SPONSOR_TTL_SECONDS = 10 * 60;

// ── Builder ──────────────────────────────────────────────────────

export function buildSponsorIntentTypedData(params: {
  preflight: FundPreflight;
  sponsor: `0x${string}`;
  amountWei: bigint;
  feeShareBps: bigint;
  feeShares: FeeShare[];
  oracle?: `0x${string}`;
  token?: `0x${string}`;
  minBondFloor?: bigint;
  bondBasisPoints?: bigint;
  minSponsorship?: bigint;
  voteFee?: bigint;
  abandonmentGracePeriod?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): SponsorIntentTypedData {
  if (!params.preflight.oracle) {
    throw new Error(
      "preflight.oracle is empty; cannot build SponsorIntent. Did the backend return mode=cosponsor?",
    );
  }
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt =
    params.expiresAtSeconds ?? now + DEFAULT_SPONSOR_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce_next);
  const oracle =
    params.oracle ?? (params.preflight.oracle as `0x${string}`);
  const token =
    params.token ??
    (params.preflight.token.contract_address as `0x${string}`);
  const minBondFloor =
    params.minBondFloor ??
    BigInt(params.preflight.min_bond_floor ?? "0");
  const bondBasisPoints =
    params.bondBasisPoints ??
    BigInt(params.preflight.bond_basis_points ?? "0");
  const minSponsorship =
    params.minSponsorship ??
    BigInt(params.preflight.min_sponsorship ?? "0");
  const voteFee =
    params.voteFee ?? BigInt(params.preflight.vote_fee ?? "0");
  const abandonmentGracePeriod =
    params.abandonmentGracePeriod ??
    BigInt(params.preflight.abandonment_grace_period ?? "0");

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chain_id,
      routerAddress: params.preflight.router_address as `0x${string}`,
    }),
    types: SPONSOR_INTENT_TYPES,
    primaryType: "SponsorIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      oracle,
      token,
      minBondFloor,
      bondBasisPoints,
      minSponsorship,
      voteFee,
      abandonmentGracePeriod,
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
// Mirrors RezonTree-UI/lib/intents/sponsor-intent.ts → snake_case
// wire shape consumed by backend's contribution.go FundRequest.

export interface SponsorFundRequestBody {
  mode: "sponsor";
  question_id: string;
  funder: string;
  amount: string;
  nonce: string;
  chain_id: string;
  expires_at: string;
  signature: string;
  fee_share_bps: string;
  fee_shares: { recipient: string; basis_points: string }[];
  oracle: string;
  token: string;
  min_bond_floor: string;
  bond_basis_points: string;
  min_sponsorship: string;
  vote_fee: string;
  abandonment_grace_period: string;
}

export function buildSponsorFundRequestBody(params: {
  typedData: SponsorIntentTypedData;
  signature: `0x${string}`;
}): SponsorFundRequestBody {
  const m = params.typedData.message;
  return {
    mode: "sponsor",
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
    oracle: m.oracle,
    token: m.token,
    min_bond_floor: m.minBondFloor.toString(),
    bond_basis_points: m.bondBasisPoints.toString(),
    min_sponsorship: m.minSponsorship.toString(),
    vote_fee: m.voteFee.toString(),
    abandonment_grace_period: m.abandonmentGracePeriod.toString(),
  };
}

// ── Amount encoding ─────────────────────────────────────────────

export function parseAmountToWei(
  humanAmount: string,
  decimals: number,
): bigint {
  const trimmed = humanAmount.trim();
  if (!trimmed) {
    throw new Error("Amount is empty.");
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Amount "${humanAmount}" is not a non-negative decimal.`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount has ${frac.length} decimal places but token supports only ${decimals}.`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole + padded);
}
