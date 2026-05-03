// Pure-function coverage for the SponsorIntent (v2.7) builders.
// 3-stack fence: field order + types here MUST match
// contracts/src/RezonForge.sol's SPONSOR_INTENT_TYPEHASH +
// internal/signer/sponsor_intent.go +
// RezonTree-UI/lib/intents/sponsor-intent.ts.

import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import {
  buildSponsorFundRequestBody,
  buildSponsorIntentTypedData,
  DEFAULT_SPONSOR_TTL_SECONDS,
  MAX_PLATFORM_FEE_BPS,
  MIN_NO_SOLUTION_GRACE,
  parseAmountToWei,
  SPONSOR_INTENT_TYPES,
} from "./sponsor-intent.js";
import { defaultFeeSharePolicy } from "./fee-share.js";
import {
  FORGE_DOMAIN_NAME,
  FORGE_DOMAIN_VERSION,
} from "./forge-domain.js";
import type { FundPreflight } from "./preflight-types.js";

const SPONSOR = "0xdEadBeEfCaFEBAbedEadbeeFcaFebabeDeadBEEF" as const;
const ORACLE = "0xCAfECAfECAFEcAfecAfECaFECAFECafeCAfECAFE" as const;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const QID =
  "0x000000000000000000000000000000000000000000000000000000000000beef" as const;
const ROUTER = "0x00000000000000000000000000000000000000ab" as const;

function sponsorPreflight(
  overrides: Partial<FundPreflight> = {},
): FundPreflight {
  return {
    mode: "sponsor",
    qid: QID,
    recommended_amount_floor: "1000000",
    token: {
      contract_address: TOKEN,
      decimals: 6,
      symbol: "USDC",
      chain_id: 84532,
    },
    forge_address: ROUTER,
    chain_id: 84532,
    nonce_next: "7",
    oracle: ORACLE,
    stake_floor: "1000000",
    stake_basis_points: "1000",
    sponsorship_floor: "1000000",
    vote_fee: "0",
    commit_fee: "0",
    no_solution_grace_period: String(MIN_NO_SOLUTION_GRACE),
    platform_fee_bps: "0",
    platform_fee_recipient: "0x0000000000000000000000000000000000000000",
    abandonment_grace_period: "86400",
    _actions: [],
    ...overrides,
  };
}

function cosponsorPreflight(
  overrides: Partial<FundPreflight> = {},
): FundPreflight {
  return {
    mode: "cosponsor",
    qid: QID,
    recommended_amount_floor: "1000000",
    token: {
      contract_address: TOKEN,
      decimals: 6,
      symbol: "USDC",
      chain_id: 84532,
    },
    forge_address: ROUTER,
    chain_id: 84532,
    nonce_next: "7",
    _actions: [],
    ...overrides,
  };
}

describe("SPONSOR_INTENT_TYPES field order", () => {
  it("matches RezonForge v2.7 typehash byte-for-byte (19 fields)", () => {
    expect(SPONSOR_INTENT_TYPES.SponsorIntent).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "oracle", type: "address" },
      { name: "token", type: "address" },
      { name: "stakeFloor", type: "uint256" },
      { name: "stakeBasisPoints", type: "uint256" },
      { name: "sponsorshipFloor", type: "uint256" },
      { name: "voteFee", type: "uint256" },
      { name: "commitFee", type: "uint256" },
      { name: "noSolutionGracePeriod", type: "uint256" },
      { name: "platformFeeBps", type: "uint256" },
      { name: "platformFeeRecipient", type: "address" },
      { name: "abandonmentGracePeriod", type: "uint256" },
      { name: "sponsor", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "feeShareBps", type: "uint256" },
      { name: "feeShares", type: "FeeShare[]" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
    expect(SPONSOR_INTENT_TYPES.FeeShare).toEqual([
      { name: "recipient", type: "address" },
      { name: "basisPoints", type: "uint256" },
    ]);
  });

  // Pinned typehash (v2.7: +commitFee, +noSolutionGracePeriod,
  // +platformFeeBps, +platformFeeRecipient after voteFee).
  // Matches Solidity SPONSOR_INTENT_TYPEHASH and Go SPONSOR_INTENT_TYPEHASH.
  it("typehash text matches the pinned cross-stack invariant", () => {
    const text =
      "SponsorIntent(bytes32 questionId,address oracle,address token,uint256 stakeFloor,uint256 stakeBasisPoints,uint256 sponsorshipFloor,uint256 voteFee,uint256 commitFee,uint256 noSolutionGracePeriod,uint256 platformFeeBps,address platformFeeRecipient,uint256 abandonmentGracePeriod,address sponsor,uint256 amount,uint256 feeShareBps,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
      "FeeShare(address recipient,uint256 basisPoints)";
    const hash = keccak256(stringToBytes(text));
    expect(hash).toBe(
      "0x46dfa40d30fc4115d754a56211df6a6344984283e98cecd57b207f22b5ba74e2",
    );
  });
});

describe("buildSponsorIntentTypedData", () => {
  const NOW = 1_714_000_000;
  const policy = defaultFeeSharePolicy(SPONSOR);

  it("composes the RezonForge v2.7 EIP-712 domain", () => {
    const td = buildSponsorIntentTypedData({
      preflight: sponsorPreflight(),
      sponsor: SPONSOR,
      amountWei: BigInt("5000000"),
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.domain.name).toBe(FORGE_DOMAIN_NAME);
    expect(td.domain.version).toBe(FORGE_DOMAIN_VERSION);
    expect(td.primaryType).toBe("SponsorIntent");
  });

  it("inherits per-Q params from preflight", () => {
    const td = buildSponsorIntentTypedData({
      preflight: sponsorPreflight(),
      sponsor: SPONSOR,
      amountWei: BigInt("5000000"),
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.message.oracle).toBe(ORACLE);
    expect(td.message.token).toBe(TOKEN);
    expect(td.message.stakeFloor).toBe(BigInt("1000000"));
    expect(td.message.stakeBasisPoints).toBe(BigInt("1000"));
    expect(td.message.sponsorshipFloor).toBe(BigInt("1000000"));
    expect(td.message.voteFee).toBe(BigInt("0"));
    // v2.7 fields:
    expect(td.message.commitFee).toBe(BigInt("0"));
    expect(td.message.noSolutionGracePeriod).toBe(MIN_NO_SOLUTION_GRACE);
    expect(td.message.platformFeeBps).toBe(BigInt("0"));
    expect(td.message.abandonmentGracePeriod).toBe(BigInt("86400"));
  });

  it("carries fee-share policy into the message", () => {
    const td = buildSponsorIntentTypedData({
      preflight: sponsorPreflight(),
      sponsor: SPONSOR,
      amountWei: BigInt("5000000"),
      feeShareBps: BigInt(1),
      feeShares: [{ recipient: SPONSOR, basisPoints: BigInt(10000) }],
      nowSeconds: NOW,
    });
    expect(td.message.feeShareBps).toBe(BigInt(1));
    expect(td.message.feeShares).toEqual([
      { recipient: SPONSOR, basisPoints: BigInt(10000) },
    ]);
  });

  it("throws on a cosponsor-mode preflight (missing oracle)", () => {
    expect(() =>
      buildSponsorIntentTypedData({
        preflight: cosponsorPreflight(),
        sponsor: SPONSOR,
        amountWei: BigInt("1000000"),
        feeShareBps: policy.bps,
        feeShares: policy.shares,
        nowSeconds: NOW,
      }),
    ).toThrow(/oracle is empty/);
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildSponsorIntentTypedData({
      preflight: sponsorPreflight(),
      sponsor: SPONSOR,
      amountWei: BigInt("1000000"),
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.message.expiresAt).toBe(
      BigInt(NOW + DEFAULT_SPONSOR_TTL_SECONDS),
    );
  });

  // Mega-audit T2 fence parity — off-chain validator must reject the
  // exact inputs the contract reverts on (R2-EB-1 / F15 / stakeBps cap).
  it("rejects sponsorshipFloor=0 (R2-EB-1 fence)", () => {
    expect(() =>
      buildSponsorIntentTypedData({
        preflight: sponsorPreflight({ sponsorship_floor: "0" }),
        sponsor: SPONSOR,
        amountWei: BigInt("1000000"),
        feeShareBps: policy.bps,
        feeShares: policy.shares,
        nowSeconds: NOW,
      }),
    ).toThrow(/ForgeZeroSponsorshipFloor/);
  });

  it("rejects voteFee=0 AND stakeFloor=0 (F15 fence)", () => {
    expect(() =>
      buildSponsorIntentTypedData({
        preflight: sponsorPreflight({
          vote_fee: "0",
          stake_floor: "0",
        }),
        sponsor: SPONSOR,
        amountWei: BigInt("1000000"),
        feeShareBps: policy.bps,
        feeShares: policy.shares,
        nowSeconds: NOW,
      }),
    ).toThrow(/ForgeZeroEconomicFloor/);
  });

  it("rejects stakeBasisPoints > 5000 (chain cap)", () => {
    expect(() =>
      buildSponsorIntentTypedData({
        preflight: sponsorPreflight({ stake_basis_points: "5001" }),
        sponsor: SPONSOR,
        amountWei: BigInt("1000000"),
        feeShareBps: policy.bps,
        feeShares: policy.shares,
        nowSeconds: NOW,
      }),
    ).toThrow(/exceeds max 5000/);
  });
});

describe("buildSponsorFundRequestBody", () => {
  const policy = defaultFeeSharePolicy(SPONSOR);
  it("renders mode=sponsor with all per-Q + fee-share fields", () => {
    const td = buildSponsorIntentTypedData({
      preflight: sponsorPreflight(),
      sponsor: SPONSOR,
      amountWei: BigInt("5000000"),
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: 1_714_000_000,
    });
    const body = buildSponsorFundRequestBody({
      typedData: td,
      signature: "0xbeef" as `0x${string}`,
    });
    expect(body.mode).toBe("sponsor");
    expect(body.oracle).toBe(ORACLE);
    expect(body.token).toBe(TOKEN);
    expect(body.stake_floor).toBe("1000000");
    expect(body.stake_basis_points).toBe("1000");
    expect(body.sponsorship_floor).toBe("1000000");
    expect(body.abandonment_grace_period).toBe("86400");
    // v2.7 fields:
    expect(body.commit_fee).toBe("0");
    expect(body.no_solution_grace_period).toBe(String(MIN_NO_SOLUTION_GRACE));
    expect(body.platform_fee_bps).toBe("0");
    expect(body.fee_share_bps).toBe("1");
    expect(body.fee_shares).toEqual([
      { recipient: SPONSOR, basis_points: "10000" },
    ]);
    expect(body.signature).toBe("0xbeef");
  });
});

describe("parseAmountToWei", () => {
  it("encodes whole amounts with zero-padding", () => {
    expect(parseAmountToWei("5", 6)).toBe(BigInt("5000000"));
  });

  it("throws when fractional precision exceeds decimals", () => {
    expect(() => parseAmountToWei("1.1234567", 6)).toThrow(
      /decimal places but token supports only 6/,
    );
  });
});
