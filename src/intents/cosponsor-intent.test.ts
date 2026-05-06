// Pure-function coverage for the CosponsorIntent (v2.5) builders.
// 3-stack fence: field order + types here MUST match
// contracts/src/RezonForge.sol's COSPONSOR_INTENT_TYPEHASH +
// internal/signer/cosponsor_intent.go +
// RezonTree-UI/lib/intents/cosponsor-intent.ts.

import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import {
  buildCosponsorFundRequestBody,
  buildCosponsorIntentTypedData,
  COSPONSOR_INTENT_TYPES,
  DEFAULT_COSPONSOR_TTL_SECONDS,
} from "./cosponsor-intent.js";
import { defaultFeeSharePolicy } from "./fee-share.js";
import {
  FORGE_DOMAIN_NAME,
  FORGE_DOMAIN_VERSION,
} from "./forge-domain.js";
import type { FundPreflight } from "./preflight-types.js";

const COSPONSOR = "0xdEadBeEfCaFEBAbedEadbeeFcaFebabeDeadBEEF" as const;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const QID =
  "0x000000000000000000000000000000000000000000000000000000000000beef" as const;
const ROUTER = "0x00000000000000000000000000000000000000ab" as const;

function preflight(overrides: Partial<FundPreflight> = {}): FundPreflight {
  return {
    mode: "cosponsor",
    qid: QID,
    recommendedAmountFloor: "1000000",
    token: {
      contractAddress: TOKEN,
      decimals: 6,
      symbol: "USDC",
      chainId: 84532,
    },
    forgeAddress: ROUTER,
    chainId: 84532,
    nonceNext: "11",
    _actions: [],
    ...overrides,
  };
}

describe("COSPONSOR_INTENT_TYPES field order", () => {
  it("matches RezonForge typehash byte-for-byte (7 fields)", () => {
    expect(COSPONSOR_INTENT_TYPES.CosponsorIntent).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "sponsor", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "feeShares", type: "FeeShare[]" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
  });

  // Pinned typehash — see typehash.test.ts for the full 5-intent fence.
  it("typehash text matches the cross-stack invariant", () => {
    const text =
      "CosponsorIntent(bytes32 questionId,address sponsor,uint256 amount,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
      "FeeShare(address recipient,uint256 basisPoints)";
    const hash = keccak256(stringToBytes(text));
    expect(hash).toBe(
      "0xd9c03036132b2691bcf944f8964155d518856f9766727315bba50e72a9769dd4",
    );
  });
});

describe("buildCosponsorIntentTypedData", () => {
  const NOW = 1_714_000_000;
  const policy = defaultFeeSharePolicy(COSPONSOR);

  it("composes the v2.5 EIP-712 domain from preflight", () => {
    const td = buildCosponsorIntentTypedData({
      preflight: preflight(),
      sponsor: COSPONSOR,
      amountWei: BigInt("5000000"),

      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.domain.name).toBe(FORGE_DOMAIN_NAME);
    expect(td.domain.version).toBe(FORGE_DOMAIN_VERSION);
    expect(td.primaryType).toBe("CosponsorIntent");
  });

  it("uses minimal body — no per-Q params", () => {
    const td = buildCosponsorIntentTypedData({
      preflight: preflight(),
      sponsor: COSPONSOR,
      amountWei: BigInt("5000000"),

      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.message.questionId).toBe(QID);
    expect(td.message.sponsor).toBe(COSPONSOR);
    expect(td.message.amount).toBe(BigInt("5000000"));
    expect(td.message.nonce).toBe(BigInt("11"));
    expect(td.message.chainId).toBe(BigInt("84532"));
    // No oracle / token / stakeFloor / etc — those live on chain.
    expect("oracle" in td.message).toBe(false);
    expect("token" in td.message).toBe(false);
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildCosponsorIntentTypedData({
      preflight: preflight(),
      sponsor: COSPONSOR,
      amountWei: BigInt("1000000"),

      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.message.expiresAt).toBe(
      BigInt(NOW + DEFAULT_COSPONSOR_TTL_SECONDS),
    );
  });
});

describe("buildCosponsorFundRequestBody", () => {
  const policy = defaultFeeSharePolicy(COSPONSOR);
  it("renders mode=cosponsor with no sponsor-only fields", () => {
    const td = buildCosponsorIntentTypedData({
      preflight: preflight(),
      sponsor: COSPONSOR,
      amountWei: BigInt("5000000"),

      feeShares: policy.shares,
      nowSeconds: 1_714_000_000,
    });
    const body = buildCosponsorFundRequestBody({
      typedData: td,
      signature: "0xcafe" as `0x${string}`,
    });
    expect(body.mode).toBe("cosponsor");
    expect("oracle" in body).toBe(false);
    expect("stakeFloor" in body).toBe(false);
    expect("sponsorshipFloor" in body).toBe(false);
    expect("abandonmentGracePeriod" in body).toBe(false);
    // v2.9: per-intent feeShareBps removed — body must NOT carry it.
    expect("feeShareBps" in body).toBe(false);
    expect(body.feeShares).toEqual([
      { recipient: COSPONSOR, basisPoints: "10000" },
    ]);
    expect(body.signature).toBe("0xcafe");
  });
});
