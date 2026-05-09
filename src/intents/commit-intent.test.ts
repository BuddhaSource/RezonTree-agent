// Pure-function coverage for the CommitIntent builders.
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
  canonicalStringify,
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
    feeAmount: "500000",
    stakeAmount: "5000000",
    token: {
      contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      symbol: "USDC",
      chainId: 84532,
    },
    forgeAddress: ROUTER,
    chainId: 84532,
    nonce: "11",
    _actions: [],
    ...overrides,
  };
}

describe("COMMIT_INTENT_TYPES field order", () => {
  it("matches typehash order + types (9 fields)", () => {
    expect(COMMIT_INTENT_TYPES.CommitIntent).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "submitter", type: "address" },
      { name: "contentHash", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
      { name: "stakeAmount", type: "uint256" },
      { name: "feeShares", type: "FeeShare[]" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
  });

  it("typehash text matches the cross-stack invariant", () => {
    const text =
      "CommitIntent(bytes32 questionId,address submitter,bytes32 contentHash,uint256 feeAmount,uint256 stakeAmount,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
      "FeeShare(address recipient,uint256 basisPoints)";
    expect(keccak256(stringToBytes(text))).toBe(
      "0x6c9a41343766487b62acf6bde0a8c4100342465502c5fe1cf72f3a36114a84a9",
    );
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
      reasoningTree: [{ because: "x", therefore: "y" }],
      claims: [],
    };
    const b: typeof a = {} as typeof a;
    // Insert in reverse / scrambled order.
    (b as Record<string, unknown>).claims = [];
    (b as Record<string, unknown>).reasoningTree = [
      { therefore: "y", because: "x" },
    ];
    (b as Record<string, unknown>).body = "hi";
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("differs when structured-body content differs", () => {
    const a = { body: "hi", reasoningTree: [], claims: [] };
    const b = { body: "hI", reasoningTree: [], claims: [] };
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  // Cross-stack pinned vector — bytes-identical to the Go fixture in
  // internal/service/content_hash_test.go::TestComputeSolutionContentHash_RoundTrip.
  // Any drift in either side breaks signature verification on chain
  // (the contentHash is signed by the submitter and recomputed by the
  // backend at submit time).
  it("matches the cross-stack pinned canonical vector", () => {
    const body = {
      body: "This is the markdown body.",
      reasoningTree: [
        { because: "premise A", therefore: "conclusion A" },
        { because: "premise B", therefore: "conclusion B" },
      ],
      claims: [
        {
          criterionId: "crit_1",
          value: 150,
          argument: "load test shows p95=150ms",
          falsifiableBy: "rerun the same load test",
        },
      ],
    };
    const expectedJSON =
      '{"body":"This is the markdown body.","claims":[{"argument":"load test shows p95=150ms","criterionId":"crit_1","falsifiableBy":"rerun the same load test","value":150}],"reasoningTree":[{"because":"premise A","therefore":"conclusion A"},{"because":"premise B","therefore":"conclusion B"}]}';
    expect(canonicalStringify(body)).toBe(expectedJSON);
    // Pin matches keccak256 of expectedJSON — the Go side asserts the
    // same hash via crypto.Keccak256([]byte(expectedJSON)).
    expect(computeContentHash(body)).toBe(
      keccak256(stringToBytes(expectedJSON)),
    );
  });
});

describe("buildCommitIntentTypedData", () => {
  const NOW = 1_714_000_000;
  const policy = defaultFeeSharePolicy(SUBMITTER);

  it("composes the EIP-712 domain from preflight", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
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
      feeShares: policy.shares,
      feeAmount: BigInt("1000"),
      stakeAmount: BigInt("2000"),
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
      feeShares: [{ recipient: SUBMITTER, basisPoints: BigInt(10000) }],
      nowSeconds: NOW,
    });
    // Per-intent feeShareBps is not part of the message (Q-level only).
    expect("feeShareBps" in td.message).toBe(false);
    expect(td.message.feeShares).toEqual([
      { recipient: SUBMITTER, basisPoints: BigInt(10000) },
    ]);
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildCommitIntentTypedData({
      preflight: preflight(),
      submitter: SUBMITTER,
      contentHash: CONTENT_HASH,
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
      feeShares: policy.shares,
      nowSeconds: 1_714_000_000,
    });
    const body = buildSubmitCommitRequestBody({
      typedData: td,
      signature: "0xbeef" as `0x${string}`,
    });
    expect(body.questionId).toBe(QID);
    expect(body.submitter).toBe(SUBMITTER);
    expect(body.contentHash).toBe(CONTENT_HASH);
    expect(body.feeAmount).toBe("500000");
    expect(body.stakeAmount).toBe("5000000");
    // Per-intent feeShareBps is not part of the wire body.
    expect("feeShareBps" in body).toBe(false);
    expect(body.feeShares).toEqual([
      { recipient: SUBMITTER, basisPoints: "10000" },
    ]);
    expect(body.signature).toBe("0xbeef");
  });
});
