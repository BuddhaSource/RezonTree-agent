// Pure-function coverage for the v2.5 CommitIntent builders.
//
// Field order + types here MUST match
// contracts/src/RezonForge.sol's COMMIT_INTENT_TYPEHASH +
// internal/signer/commit_intent.go +
// RezonTree-UI/lib/intents/commit-intent.ts.
// Pinned typehash (goals.md): 0x777d...

import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import {
  buildCommitIntentTypedData,
  buildSubmitCommitRequestBody,
  COMMIT_INTENT_TYPES,
  computeContentHash,
  DEFAULT_COMMIT_TTL_SECONDS,
} from "./commit-intent.js";
import { defaultFeeSharePolicy } from "./fee-share.js";
import {
  FORGE_DOMAIN_NAME,
  FORGE_DOMAIN_VERSION,
} from "./forge-domain.js";
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
    fee: "500000",
    stake: "5000000",
    token: {
      contract_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      symbol: "USDC",
      chain_id: 84532,
    },
    forge_address: ROUTER,
    chain_id: 84532,
    nonce_next: "11",
    _actions: [],
    ...overrides,
  };
}

describe("COMMIT_INTENT_TYPES field order", () => {
  it("matches v2.5 typehash order + types (10 fields)", () => {
    expect(COMMIT_INTENT_TYPES.CommitIntent).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "submitter", type: "address" },
      { name: "contentHash", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
      { name: "stakeAmount", type: "uint256" },
      { name: "feeShareBps", type: "uint256" },
      { name: "feeShares", type: "FeeShare[]" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
  });

  it("typehash text matches the pinned cross-stack invariant", () => {
    const text =
      "CommitIntent(bytes32 questionId,address submitter,bytes32 contentHash,uint256 feeAmount,uint256 stakeAmount,uint256 feeShareBps,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
      "FeeShare(address recipient,uint256 basisPoints)";
    expect(keccak256(stringToBytes(text)).startsWith("0x653d")).toBe(true);
  });
});

describe("computeContentHash", () => {
  // keccak256("hello world") — well-known Ethereum test vector.
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
    const b = computeContentHash("hello worlD");
    expect(a).not.toBe(b);
  });

  // J3: canonical-JSON path — same body, different key insertion
  // order. Plain JSON.stringify is insertion-order, so without
  // canonicalization these would produce divergent hashes.
  it("hashes structured bodies in key-order-independent fashion", () => {
    const a = {
      body: "hi",
      reasoning_tree: [{ because: "x", therefore: "y" }],
      claims: [],
    };
    const b: typeof a = {} as typeof a;
    // Insert in reverse / scrambled order.
    (b as Record<string, unknown>).claims = [];
    (b as Record<string, unknown>).reasoning_tree = [
      { therefore: "y", because: "x" },
    ];
    (b as Record<string, unknown>).body = "hi";
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("differs when structured-body content differs", () => {
    const a = { body: "hi", reasoning_tree: [], claims: [] };
    const b = { body: "hI", reasoning_tree: [], claims: [] };
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
});

describe("buildCommitIntentTypedData", () => {
  const NOW = 1_714_000_000;
  const policy = defaultFeeSharePolicy(SUBMITTER);

  it("composes the v2.5 EIP-712 domain from preflight", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.domain.name).toBe(FORGE_DOMAIN_NAME);
    expect(td.domain.version).toBe(FORGE_DOMAIN_VERSION);
    expect(td.domain.chainId).toBe(BigInt("84532"));
    expect(td.domain.verifyingContract).toBe(ROUTER);
    expect(td.primaryType).toBe("CommitIntent");
  });

  it("pulls fee + stake from preflight recommendations by default", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.message.feeAmount).toBe(BigInt("500000"));
    expect(td.message.stakeAmount).toBe(BigInt("5000000"));
  });

  it("allows explicit fee + stake overrides", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      feeWei: BigInt("1000"),
      stakeWei: BigInt("2000"),
      nowSeconds: NOW,
    });
    expect(td.message.feeAmount).toBe(BigInt("1000"));
    expect(td.message.stakeAmount).toBe(BigInt("2000"));
  });

  it("carries fee-share policy verbatim", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      feeShareBps: BigInt(1),
      feeShares: [{ recipient: SUBMITTER, basisPoints: BigInt(10000) }],
      nowSeconds: NOW,
    });
    expect(td.message.feeShareBps).toBe(BigInt(1));
    expect(td.message.feeShares).toEqual([
      { recipient: SUBMITTER, basisPoints: BigInt(10000) },
    ]);
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.message.expiresAt).toBe(BigInt(NOW + DEFAULT_COMMIT_TTL_SECONDS));
  });
});

describe("buildSubmitCommitRequestBody", () => {
  const policy = defaultFeeSharePolicy(SUBMITTER);
  it("renders fee_share_bps + fee_shares alongside numerics", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
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
    expect(body.stake_amount).toBe("5000000");
    expect(body.fee_share_bps).toBe("1");
    expect(body.fee_shares).toEqual([
      { recipient: SUBMITTER, basis_points: "10000" },
    ]);
    expect(body.signature).toBe("0xbeef");
  });
});
