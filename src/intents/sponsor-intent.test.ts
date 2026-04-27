// Pure-function coverage for the SponsorIntent (v2.5) builders.
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
    router_address: ROUTER,
    chain_id: 84532,
    nonce_next: "7",
    oracle: ORACLE,
    min_bond_floor: "1000000",
    bond_basis_points: "1000",
    min_sponsorship: "1000000",
    vote_fee: "0",
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
    router_address: ROUTER,
    chain_id: 84532,
    nonce_next: "7",
    _actions: [],
    ...overrides,
  };
}

describe("SPONSOR_INTENT_TYPES field order", () => {
  it("matches RezonForge typehash byte-for-byte (15 fields)", () => {
    expect(SPONSOR_INTENT_TYPES.SponsorIntent).toEqual([
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
    ]);
    expect(SPONSOR_INTENT_TYPES.FeeShare).toEqual([
      { name: "recipient", type: "address" },
      { name: "basisPoints", type: "uint256" },
    ]);
  });

  // Pinned typehash (per goals.md): 0x8bd5...
  it("typehash text matches the pinned cross-stack invariant", () => {
    const text =
      "SponsorIntent(bytes32 questionId,address oracle,address token,uint256 minBondFloor,uint256 bondBasisPoints,uint256 minSponsorship,uint256 voteFee,uint256 abandonmentGracePeriod,address sponsor,uint256 amount,uint256 feeShareBps,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
      "FeeShare(address recipient,uint256 basisPoints)";
    const hash = keccak256(stringToBytes(text));
    // Lock the prefix that goals.md pins.
    expect(hash.startsWith("0x8bd5")).toBe(true);
  });
});

describe("buildSponsorIntentTypedData", () => {
  const NOW = 1_714_000_000;
  const policy = defaultFeeSharePolicy(SPONSOR);

  it("composes the RezonForge v2.5 EIP-712 domain", () => {
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
    expect(td.message.minBondFloor).toBe(BigInt("1000000"));
    expect(td.message.bondBasisPoints).toBe(BigInt("1000"));
    expect(td.message.minSponsorship).toBe(BigInt("1000000"));
    expect(td.message.voteFee).toBe(BigInt("0"));
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
    expect(body.min_bond_floor).toBe("1000000");
    expect(body.bond_basis_points).toBe("1000");
    expect(body.min_sponsorship).toBe("1000000");
    expect(body.abandonment_grace_period).toBe("86400");
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
