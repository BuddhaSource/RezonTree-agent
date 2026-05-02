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
//     uint256 stakeFloor,uint256 stakeBasisPoints,uint256 sponsorshipFloor,
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
    { name: "stakeFloor", type: "uint256" },
    { name: "stakeBasisPoints", type: "uint256" },
    { name: "sponsorshipFloor", type: "uint256" },
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
  stakeFloor: bigint;
  stakeBasisPoints: bigint;
  sponsorshipFloor: bigint;
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

// MAX_STAKE_BASIS_POINTS mirrors RezonForge.MAX_STAKE_BASIS_POINTS
// (5000 bps = 50%). Exceeding it reverts on-chain; mirror as a hard
// cap in the off-chain validator.
export const MAX_STAKE_BASIS_POINTS = 5000n;

// ── Builder ──────────────────────────────────────────────────────

export function buildSponsorIntentTypedData(params: {
  preflight: FundPreflight;
  sponsor: `0x${string}`;
  amountWei: bigint;
  feeShareBps: bigint;
  feeShares: FeeShare[];
  oracle?: `0x${string}`;
  token?: `0x${string}`;
  stakeFloor?: bigint;
  stakeBasisPoints?: bigint;
  sponsorshipFloor?: bigint;
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
  const stakeFloor =
    params.stakeFloor ??
    BigInt(params.preflight.stake_floor ?? "0");
  const stakeBasisPoints =
    params.stakeBasisPoints ??
    BigInt(params.preflight.stake_basis_points ?? "0");
  const sponsorshipFloor =
    params.sponsorshipFloor ??
    BigInt(params.preflight.sponsorship_floor ?? "0");
  const voteFee =
    params.voteFee ?? BigInt(params.preflight.vote_fee ?? "0");
  const abandonmentGracePeriod =
    params.abandonmentGracePeriod ??
    BigInt(params.preflight.abandonment_grace_period ?? "0");

  // ─── Contract-mirroring fence (mega-audit T2) ────────────────
  // R2-EB-1 / F15 / stakeBasisPoints cap match RezonForge.sol guards
  // exactly. Rejecting here costs zero gas; signing-then-reverting
  // costs one wasted broadcast. Keep parity with Go signer
  // (internal/signer/sponsor_intent.go Validate) and Solidity guards.
  if (sponsorshipFloor <= 0n) {
    throw new Error(
      "sponsor intent: sponsorshipFloor must be > 0 (chain reverts ForgeZeroSponsorshipFloor per R2-EB-1)",
    );
  }
  if (voteFee === 0n && stakeFloor === 0n) {
    throw new Error(
      "sponsor intent: voteFee > 0 OR stakeFloor > 0 required (chain reverts ForgeZeroEconomicFloor per F15)",
    );
  }
  if (stakeBasisPoints > MAX_STAKE_BASIS_POINTS) {
    throw new Error(
      `sponsor intent: stakeBasisPoints ${stakeBasisPoints} exceeds max ${MAX_STAKE_BASIS_POINTS} (chain reverts on >5000)`,
    );
  }

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chain_id,
      forgeAddress: params.preflight.forge_address as `0x${string}`,
    }),
    types: SPONSOR_INTENT_TYPES,
    primaryType: "SponsorIntent",
    message: {
      questionId: params.preflight.qid as `0x${string}`,
      oracle,
      token,
      stakeFloor,
      stakeBasisPoints,
      sponsorshipFloor,
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
  stake_floor: string;
  stake_basis_points: string;
  sponsorship_floor: string;
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
    stake_floor: m.stakeFloor.toString(),
    stake_basis_points: m.stakeBasisPoints.toString(),
    sponsorship_floor: m.sponsorshipFloor.toString(),
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
