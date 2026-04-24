// Pure-function coverage for the CommitIntent builders (loop 0067).
//
// Mirrors tests/unit/fund-intent.test.ts. Field order + types MUST
// match backend's internal/signer/commit_intent.go:
//
//   CommitIntent(bytes32 questionId,address submitter,bytes32 contentHash,uint256 feeAmount,uint256 bondAmount,uint256 nonce,uint256 chainId,uint256 expiresAt)
//
// Any drift yields signatures the Router rejects as RouterBadSigner.

import { describe, expect, it } from "vitest";
import {
  buildCommitIntentTypedData,
  buildSubmitCommitRequestBody,
  COMMIT_INTENT_TYPES,
  computeContentHash,
  DEFAULT_COMMIT_TTL_SECONDS,
} from "./commit-intent.js";
import {
  ROUTER_DOMAIN_NAME,
  ROUTER_DOMAIN_VERSION,
} from "./router-domain.js";
import type { CommitPreflight } from "./preflight-types.js";

const SUBMITTER = "0xdEadBeEfCaFEBAbedEadbeeFcaFebabeDeadBEEF" as const;
const QID =
  "0x000000000000000000000000000000000000000000000000000000000000beef" as const;
const ROUTER = "0x00000000000000000000000000000000000000ab" as const;
const CONTENT_HASH =
  "0x47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad" as const;

function preflight(overrides: Partial<CommitPreflight> = {}): CommitPreflight {
  return {
    qid: QID,
    recommended_fee: "500000",
    recommended_bond: "5000000",
    token: {
      contract_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      symbol: "USDC",
      chain_id: 84532,
    },
    router_address: ROUTER,
    chain_id: 84532,
    nonce_next: "11",
    _actions: [],
    ...overrides,
  };
}

describe("COMMIT_INTENT_TYPES field order", () => {
  it("matches backend typehash order + types", () => {
    const fields = COMMIT_INTENT_TYPES.CommitIntent;
    expect(fields).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "submitter", type: "address" },
      { name: "contentHash", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
      { name: "bondAmount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
  });
});

describe("computeContentHash", () => {
  // keccak256("hello world") — well-known Ethereum test vector. Kept
  // here as the cross-language invariant that binds UI hashing to
  // whatever downstream consumer re-verifies the hash.
  it("matches the keccak256 vector for 'hello world'", () => {
    expect(computeContentHash("hello world")).toBe(
      "0x47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad",
    );
  });

  it("matches the keccak256 vector for the empty string", () => {
    expect(computeContentHash("")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("is deterministic", () => {
    const a = computeContentHash("a solution body");
    const b = computeContentHash("a solution body");
    expect(a).toBe(b);
  });

  it("differs for differing content (avalanche)", () => {
    const a = computeContentHash("hello world");
    const b = computeContentHash("hello worlD"); // one-char flip
    expect(a).not.toBe(b);
  });
});

describe("buildCommitIntentTypedData", () => {
  const NOW = 1_714_000_000;

  it("composes the Router v2 EIP-712 domain from preflight", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nowSeconds: NOW,
    });
    expect(td.domain.name).toBe(ROUTER_DOMAIN_NAME);
    expect(td.domain.version).toBe(ROUTER_DOMAIN_VERSION);
    expect(td.domain.chainId).toBe(BigInt("84532"));
    expect(td.domain.verifyingContract).toBe(ROUTER);
    expect(td.primaryType).toBe("CommitIntent");
  });

  it("pulls fee + bond from preflight recommendations by default", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nowSeconds: NOW,
    });
    expect(td.message.feeAmount).toBe(BigInt("500000"));
    expect(td.message.bondAmount).toBe(BigInt("5000000"));
  });

  it("allows explicit fee + bond overrides", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      feeWei: BigInt("1000"),
      bondWei: BigInt("2000"),
      nowSeconds: NOW,
    });
    expect(td.message.feeAmount).toBe(BigInt("1000"));
    expect(td.message.bondAmount).toBe(BigInt("2000"));
  });

  it("pulls nonce from preflight by default + respects override", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight({ nonce_next: "99" }),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nowSeconds: NOW,
    });
    expect(td.message.nonce).toBe(BigInt("99"));

    const td2 = buildCommitIntentTypedData({
      preflight: preflight({ nonce_next: "99" }),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nonce: BigInt("500"),
      nowSeconds: NOW,
    });
    expect(td2.message.nonce).toBe(BigInt("500"));
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nowSeconds: NOW,
    });
    expect(td.message.expiresAt).toBe(BigInt(NOW + DEFAULT_COMMIT_TTL_SECONDS));
  });

  it("carries questionId / submitter / contentHash / chainId verbatim", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nowSeconds: NOW,
    });
    expect(td.message.questionId).toBe(QID);
    expect(td.message.submitter).toBe(SUBMITTER);
    expect(td.message.contentHash).toBe(CONTENT_HASH);
    expect(td.message.chainId).toBe(BigInt("84532"));
  });

  it("treats missing recommended_fee / recommended_bond as zero", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight({ recommended_fee: "", recommended_bond: "" }),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nowSeconds: NOW,
    });
    expect(td.message.feeAmount).toBe(BigInt("0"));
    expect(td.message.bondAmount).toBe(BigInt("0"));
  });
});

describe("buildSubmitCommitRequestBody", () => {
  it("renders every numeric as a decimal string", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      nowSeconds: 1_714_000_000,
    });
    const body = buildSubmitCommitRequestBody({
      typedData: td,
      signature: "0xbeef" as `0x${string}`,
    });
    expect(body.question_id).toBe(QID);
    expect(body.submitter).toBe(SUBMITTER);
    expect(body.content_hash).toBe(CONTENT_HASH);
    expect(body.fee_amount).toBe("500000");
    expect(body.bond_amount).toBe("5000000");
    expect(body.nonce).toBe("11");
    expect(body.chain_id).toBe("84532");
    expect(body.expires_at).toBe(
      String(1_714_000_000 + DEFAULT_COMMIT_TTL_SECONDS),
    );
    expect(body.signature).toBe("0xbeef");
  });
});
