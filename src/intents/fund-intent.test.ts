// Pure-function coverage for the FundIntent builders (loop 0066).
//
// The field order + types here MUST match backend's FUND_INTENT_TYPEHASH
// in `internal/signer/fund_intent.go`:
//
//   FundIntent(bytes32 questionId,address funder,uint256 amount,uint256 nonce,uint256 chainId,uint256 expiresAt)
//
// Any drift produces signatures the Router rejects on-chain as
// RouterBadSigner. These tests pin the wire shape; when the backend
// signer evolves, update both in lockstep.

import { describe, expect, it } from "vitest";
import {
  buildFundIntentTypedData,
  buildFundRequestBody,
  DEFAULT_FUND_TTL_SECONDS,
  FUND_INTENT_TYPES,
  parseAmountToWei,
} from "./fund-intent.js";
import {
  ROUTER_DOMAIN_NAME,
  ROUTER_DOMAIN_VERSION,
} from "./router-domain.js";
import type { FundPreflight } from "./preflight-types.js";

const FUNDER = "0xdEadBeEfCaFEBAbedEadbeeFcaFebabeDeadBEEF" as const;
const QID =
  "0x000000000000000000000000000000000000000000000000000000000000beef" as const;
const ROUTER = "0x00000000000000000000000000000000000000ab" as const;

function preflight(overrides: Partial<FundPreflight> = {}): FundPreflight {
  return {
    qid: QID,
    recommended_amount_floor: "1000000",
    token: {
      contract_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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

describe("FUND_INTENT_TYPES field order", () => {
  it("matches backend typehash order + types", () => {
    const fields = FUND_INTENT_TYPES.FundIntent;
    expect(fields).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "funder", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
  });
});

describe("buildFundIntentTypedData", () => {
  const NOW = 1_714_000_000;

  it("composes the Router v2 EIP-712 domain from preflight", () => {
    const td = buildFundIntentTypedData({
      preflight: preflight(),
      funder: FUNDER,
      amountWei: BigInt("5000000"),
      nowSeconds: NOW,
    });
    expect(td.domain.name).toBe(ROUTER_DOMAIN_NAME);
    expect(td.domain.version).toBe(ROUTER_DOMAIN_VERSION);
    expect(td.domain.chainId).toBe(BigInt("84532"));
    expect(td.domain.verifyingContract).toBe(ROUTER);
    expect(td.primaryType).toBe("FundIntent");
  });

  it("pulls nonce from preflight.nonce_next by default", () => {
    const td = buildFundIntentTypedData({
      preflight: preflight({ nonce_next: "42" }),
      funder: FUNDER,
      amountWei: BigInt("1"),
      nowSeconds: NOW,
    });
    expect(td.message.nonce).toBe(BigInt("42"));
  });

  it("allows explicit nonce override", () => {
    const td = buildFundIntentTypedData({
      preflight: preflight({ nonce_next: "42" }),
      funder: FUNDER,
      amountWei: BigInt("1"),
      nonce: BigInt("99"),
      nowSeconds: NOW,
    });
    expect(td.message.nonce).toBe(BigInt("99"));
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildFundIntentTypedData({
      preflight: preflight(),
      funder: FUNDER,
      amountWei: BigInt("1"),
      nowSeconds: NOW,
    });
    expect(td.message.expiresAt).toBe(BigInt(NOW + DEFAULT_FUND_TTL_SECONDS));
  });

  it("carries questionId/funder/amount/chainId verbatim", () => {
    const td = buildFundIntentTypedData({
      preflight: preflight(),
      funder: FUNDER,
      amountWei: BigInt("12345678"),
      nowSeconds: NOW,
    });
    expect(td.message.questionId).toBe(QID);
    expect(td.message.funder).toBe(FUNDER);
    expect(td.message.amount).toBe(BigInt("12345678"));
    expect(td.message.chainId).toBe(BigInt("84532"));
  });
});

describe("buildFundRequestBody", () => {
  it("renders every numeric as a decimal string", () => {
    const td = buildFundIntentTypedData({
      preflight: preflight(),
      funder: FUNDER,
      amountWei: BigInt("5000000"),
      nowSeconds: 1_714_000_000,
    });
    const body = buildFundRequestBody({
      typedData: td,
      signature: "0xbeef" as `0x${string}`,
    });
    expect(body.question_id).toBe(QID);
    expect(body.funder).toBe(FUNDER);
    expect(body.amount).toBe("5000000");
    expect(body.nonce).toBe("7"); // from preflight default
    expect(body.chain_id).toBe("84532");
    expect(body.expires_at).toBe(
      String(1_714_000_000 + DEFAULT_FUND_TTL_SECONDS),
    );
    expect(body.signature).toBe("0xbeef");
  });
});

describe("parseAmountToWei", () => {
  it("encodes whole amounts with zero-padding", () => {
    expect(parseAmountToWei("5", 6)).toBe(BigInt("5000000"));
    expect(parseAmountToWei("5", 18)).toBe(BigInt("5000000000000000000"));
  });

  it("encodes fractional amounts without precision loss", () => {
    expect(parseAmountToWei("5.25", 6)).toBe(BigInt("5250000"));
    expect(parseAmountToWei("0.000001", 6)).toBe(BigInt("1"));
  });

  it("pads short fractions with trailing zeros", () => {
    expect(parseAmountToWei("1.5", 6)).toBe(BigInt("1500000"));
  });

  it("accepts 0", () => {
    expect(parseAmountToWei("0", 6)).toBe(BigInt("0"));
    expect(parseAmountToWei("0.0", 6)).toBe(BigInt("0"));
  });

  it("throws on empty input", () => {
    expect(() => parseAmountToWei("", 6)).toThrow();
    expect(() => parseAmountToWei("   ", 6)).toThrow();
  });

  it("throws on non-numeric input", () => {
    expect(() => parseAmountToWei("abc", 6)).toThrow();
    expect(() => parseAmountToWei("1.2.3", 6)).toThrow();
    expect(() => parseAmountToWei("-5", 6)).toThrow();
  });

  it("throws when fractional precision exceeds the token's decimals", () => {
    expect(() => parseAmountToWei("1.1234567", 6)).toThrow(
      /decimal places but token supports only 6/,
    );
  });
});
