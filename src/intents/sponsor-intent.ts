// sponsor-intent.ts — SponsorIntent EIP-712 builders.
//
// Signed by the FIRST sponsor of a question. Carries the full per-Q
// parameter set (oracle / token / floors / voteFee / commitFee /
// noSolutionGracePeriod / feeShareBps / platformFeeRecipient /
// abandonmentGracePeriod / fundingDeadline) that the chain pins on
// first contact; subsequent contributors use CosponsorIntent
// (cosponsor-intent.ts) and inherit those params from chain state.
// The Q-level feeShareBps applies to every contribution (sponsor +
// cosponsor + commit fee + vote fee); intents do not carry a
// per-contribution rate.
//
// Chain-side fences relevant to construction:
//   - sponsorshipFloor must be > 0 (ForgeZeroSponsorshipFloor).
//   - At least one of commitFee, stakeFloor, or stakeBasisPoints
//     must be > 0; voteFee alone doesn't gate commits
//     (ForgeZeroCommitCost).
//   - fundingDeadline (sponsor-signed funding-window deadline) must
//     be > now AND >= expiresAt; cosponsor/commit/vote revert past
//     it (ForgeFundingDeadlinePassed).
//   - stakeBasisPoints capped at MAX_STAKE_BASIS_POINTS.
//   - feeShareBps capped at MAX_FEE_SHARE_BPS.
//
// 3-stack fence: Solidity (contracts/src/RezonForge.sol) ↔ Go
// (internal/signer/sponsor_intent.go) ↔ TS (this file +
// RezonTree-UI/lib/intents/sponsor-intent.ts). Any drift surfaces as
// a bad-signer revert on chain. typehash.test.ts pins the literal
// hex against drift.
//
// R-CHAIN-VERIFIES-INTENT — the signature is verified on-chain.
// R-CLIENT-IS-TRUST-ORIGIN — client constructs from advertised params.
// R-INTENT-CARRIES-EXPIRY — ExpiresAt is mandatory and short.

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
    { name: "commitFee", type: "uint256" },
    { name: "noSolutionGracePeriod", type: "uint256" },
    // Q-level feeShareBps; frozen at sponsor() for the question's
    // lifetime — applies to every contribution (sponsor + cosponsor
    // + commit fee + vote fee).
    { name: "feeShareBps", type: "uint256" },
    { name: "platformFeeRecipient", type: "address" },
    { name: "abandonmentGracePeriod", type: "uint256" },
    // Sponsor-signed funding-window deadline.
    { name: "fundingDeadline", type: "uint256" },
    { name: "sponsor", type: "address" },
    { name: "amount", type: "uint256" },
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
  commitFee: bigint;
  noSolutionGracePeriod: bigint;
  // Q-level fee rate.
  feeShareBps: bigint;
  platformFeeRecipient: `0x${string}`;
  abandonmentGracePeriod: bigint;
  // Sponsor-signed funding-window deadline.
  fundingDeadline: bigint;
  sponsor: `0x${string}`;
  amount: bigint;
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
// R-INTENT-CARRIES-EXPIRY: every signed intent declares its own TTL.
export const DEFAULT_SPONSOR_TTL_SECONDS = 4 * 60;

// MAX_STAKE_BASIS_POINTS mirrors RezonForge.MAX_STAKE_BASIS_POINTS
// (5000 bps = 50%).
export const MAX_STAKE_BASIS_POINTS = 5000n;

// ── Builder ──────────────────────────────────────────────────────

export const MIN_NO_SOLUTION_GRACE = 1800n;  // 30 minutes
export const MAX_NO_SOLUTION_GRACE = 86400n; // 24 hours
// Cap for the Q-level feeShareBps. Mirrors RezonForge.MAX_FEE_SHARE_BPS.
export const MAX_FEE_SHARE_BPS = 5000n;       // 50%

export function buildSponsorIntentTypedData(params: {
  preflight: FundPreflight;
  sponsor: `0x${string}`;
  amountWei: bigint;
  feeShares?: FeeShare[];
  oracle?: `0x${string}`;
  token?: `0x${string}`;
  stakeFloor?: bigint;
  stakeBasisPoints?: bigint;
  sponsorshipFloor?: bigint;
  voteFee?: bigint;
  commitFee?: bigint;
  noSolutionGracePeriod?: bigint;
  // Q-level fee rate.
  feeShareBps?: bigint;
  platformFeeRecipient?: `0x${string}`;
  abandonmentGracePeriod?: bigint;
  // Sponsor-signed funding-window deadline (unix seconds).
  // Defaults to preflight.recommendedFundingDeadline (advertised by backend).
  fundingDeadline?: bigint;
  expiresAtSeconds?: number;
  nonce?: bigint;
  nowSeconds?: number;
}): SponsorIntentTypedData {
  if (!params.preflight.oracle) {
    throw new Error(
      "preflight.oracle is empty; cannot build SponsorIntent. Did the backend return mode=cosponsor?",
    );
  }
  // Defensive null-checks — fail with an actionable error before
  // BigInt()/hexToBytes() blow up deep in the builder.
  requireHexString(params.preflight.qid, "qid");
  requireString(params.preflight.nonce, "nonce");
  requireNonZeroNumber(params.preflight.chainId, "chainId");
  requireString(params.preflight.forgeAddress, "forgeAddress");
  requireString(params.preflight.token?.contractAddress, "token.contractAddress");
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt =
    params.expiresAtSeconds ?? now + DEFAULT_SPONSOR_TTL_SECONDS;
  const nonce = params.nonce ?? BigInt(params.preflight.nonce);
  const oracle =
    params.oracle ?? (params.preflight.oracle as `0x${string}`);
  const token =
    params.token ??
    (params.preflight.token.contractAddress as `0x${string}`);
  const stakeFloor =
    params.stakeFloor ?? BigInt(params.preflight.stakeFloor ?? "0");
  const stakeBasisPoints =
    params.stakeBasisPoints ??
    BigInt(params.preflight.stakeBasisPoints ?? "0");
  const sponsorshipFloor =
    params.sponsorshipFloor ??
    BigInt(params.preflight.sponsorshipFloor ?? "0");
  const voteFee =
    params.voteFee ?? BigInt(params.preflight.voteFee ?? "0");
  const commitFee =
    params.commitFee ?? BigInt(params.preflight.commitFee ?? "0");
  const noSolutionGracePeriod =
    params.noSolutionGracePeriod ??
    BigInt(params.preflight.noSolutionGracePeriod ?? String(MIN_NO_SOLUTION_GRACE));
  // Prefer explicit param, fall back to preflight.feeShareBps,
  // then preflight.platformFeeBps for legacy backends.
  const feeShareBps =
    params.feeShareBps ??
    BigInt(
      params.preflight.feeShareBps ??
        params.preflight.platformFeeBps ??
        "0",
    );
  const platformFeeRecipient =
    (params.platformFeeRecipient ??
      (params.preflight.platformFeeRecipient as `0x${string}` | undefined) ??
      "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const abandonmentGracePeriod =
    params.abandonmentGracePeriod ??
    BigInt(params.preflight.abandonmentGracePeriod ?? "0");
  // fundingDeadline. Prefer explicit param, then
  // preflight.recommendedFundingDeadline. Fall back to expiresAt as a
  // last resort so calls don't break before backends advertise the
  // field — but the chain may revert if it equals expiresAt and
  // expiresAt < now by then.
  const fundingDeadline =
    params.fundingDeadline ??
    BigInt(params.preflight.recommendedFundingDeadline ?? expiresAt.toString());

  // ─── Contract-mirroring fence ────────────────────────────────
  if (sponsorshipFloor <= 0n) {
    throw new Error(
      "sponsor intent: sponsorshipFloor must be > 0 (chain reverts ForgeZeroSponsorshipFloor per R2-EB-1)",
    );
  }
  // Vote-fee alone is not sufficient — must have a COMMIT-side cost
  // (commitFee | stakeFloor | stakeBasisPoints).
  if (commitFee === 0n && stakeFloor === 0n && stakeBasisPoints === 0n) {
    throw new Error(
      "sponsor intent: at least one of commitFee, stakeFloor, or stakeBasisPoints must be > 0 (chain reverts ForgeZeroCommitCost)",
    );
  }
  // fundingDeadline must outlast the broadcast window.
  if (fundingDeadline < BigInt(expiresAt)) {
    throw new Error(
      `sponsor intent: fundingDeadline ${fundingDeadline} must be >= expiresAt ${expiresAt} (chain reverts ForgeFundingDeadlinePassed)`,
    );
  }
  if (stakeBasisPoints > MAX_STAKE_BASIS_POINTS) {
    throw new Error(
      `sponsor intent: stakeBasisPoints ${stakeBasisPoints} exceeds max ${MAX_STAKE_BASIS_POINTS} (chain reverts on >5000)`,
    );
  }
  if (feeShareBps > MAX_FEE_SHARE_BPS) {
    throw new Error(
      `sponsor intent: feeShareBps ${feeShareBps} exceeds max ${MAX_FEE_SHARE_BPS} (chain reverts ForgeFeeShareBpsTooHigh)`,
    );
  }
  if (noSolutionGracePeriod < MIN_NO_SOLUTION_GRACE || noSolutionGracePeriod > MAX_NO_SOLUTION_GRACE) {
    throw new Error(
      `sponsor intent: noSolutionGracePeriod ${noSolutionGracePeriod} outside [${MIN_NO_SOLUTION_GRACE}, ${MAX_NO_SOLUTION_GRACE}]`,
    );
  }
  // R-CLIENT-IS-TRUST-ORIGIN: refuse to sign if the platform fee
  // recipient is missing — chain reverts ForgePlatformRecipientRequired
  // and silent zero-address signing is a R-CHAIN-VERIFIES-INTENT trap.
  if (
    platformFeeRecipient.toLowerCase() ===
    "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error(
      "sponsor intent: platformFeeRecipient missing. Backend preflight must advertise FORGE_DEFAULT_PLATFORM_FEE_RECIPIENT or pass an explicit value.",
    );
  }
  // _validateFeeShareInvariants requires platformFeeRecipient to appear
  // in feeShares[]. Insert at 10% bps if absent (rebalances the rest).
  const baseShares =
    params.feeShares ?? defaultFeeSharePolicy(params.sponsor).shares;
  const feeShares = ensurePlatformFeeInShares(
    baseShares,
    platformFeeRecipient,
  );

  return {
    domain: buildForgeDomain({
      chainId: params.preflight.chainId,
      forgeAddress: params.preflight.forgeAddress as `0x${string}`,
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
      commitFee,
      noSolutionGracePeriod,
      feeShareBps,
      platformFeeRecipient,
      abandonmentGracePeriod,
      fundingDeadline,
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

export interface SponsorFundRequestBody {
  mode: "sponsor";
  questionId: string;
  sponsor: string;
  amount: string;
  nonce: string;
  chainId: number;
  expiresAt: number;
  signature: string;
  feeShares: { recipient: string; basisPoints: string }[];
  oracle: string;
  token: string;
  stakeFloor: string;
  stakeBasisPoints: string;
  sponsorshipFloor: string;
  voteFee: string;
  commitFee: string;
  noSolutionGracePeriod: string;
  // Q-level fee rate.
  feeShareBps: string;
  platformFeeRecipient: string;
  abandonmentGracePeriod: string;
  // Sponsor-signed funding-window deadline (unix seconds).
  fundingDeadline: string;
}

export function buildSponsorFundRequestBody(params: {
  typedData: SponsorIntentTypedData;
  signature: `0x${string}`;
}): SponsorFundRequestBody {
  const m = params.typedData.message;
  return {
    mode: "sponsor",
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
    oracle: m.oracle,
    token: m.token,
    stakeFloor: m.stakeFloor.toString(),
    stakeBasisPoints: m.stakeBasisPoints.toString(),
    sponsorshipFloor: m.sponsorshipFloor.toString(),
    voteFee: m.voteFee.toString(),
    commitFee: m.commitFee.toString(),
    noSolutionGracePeriod: m.noSolutionGracePeriod.toString(),
    feeShareBps: m.feeShareBps.toString(),
    platformFeeRecipient: m.platformFeeRecipient,
    abandonmentGracePeriod: m.abandonmentGracePeriod.toString(),
    fundingDeadline: m.fundingDeadline.toString(),
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
