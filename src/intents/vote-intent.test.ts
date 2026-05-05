// Pure-function coverage for the v2.5 VoteIntent builders.
//
// Field order + types here MUST match
// contracts/src/RezonForge.sol's VOTE_INTENT_TYPEHASH +
// internal/signer/vote_intent.go +
// RezonTree-UI/lib/intents/vote-intent.ts.
// Pinned typehash (goals.md): 0x48aa...
//
// Two extra invariants to pin:
//
//   1. Allocations canonical encoding — sorted-by-solutionId
//      ASC, JSON object with solutionId-then-points keys, no
//      whitespace.
//   2. computeAllocationsHash keccak256 over UTF-8-encoded
//      canonical bytes.

import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { defaultFeeSharePolicy } from "./fee-share.js";
import {
  FORGE_DOMAIN_NAME,
  FORGE_DOMAIN_VERSION,
} from "./forge-domain.js";
import {
  type Allocation,
  buildSubmitVoteIntentRequestBody,
  buildVoteIntentTypedData,
  canonicalizeAllocations,
  computeAllocationsHash,
  DEFAULT_VOTE_TTL_SECONDS,
  validateAllocations,
  VOTE_INTENT_TYPES,
} from "./vote-intent.js";
import type { VotePreflight } from "./preflight-types.js";

const VOTER = "0xdEadBeEfCaFEBAbedEadbeeFcaFebabeDeadBEEF" as const;
const QID =
  "0x000000000000000000000000000000000000000000000000000000000000beef" as const;
const ROUTER = "0x00000000000000000000000000000000000000ab" as const;

function preflight(overrides: Partial<VotePreflight> = {}): VotePreflight {
  return {
    qid: QID,
    feeAmount: "100000",
    stakeAmount: "1000000",
    token: {
      contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      symbol: "USDC",
      chainId: 84532,
    },
    forgeAddress: ROUTER,
    chainId: 84532,
    nonceNext: "3",
    _actions: [],
    ...overrides,
  };
}

describe("VOTE_INTENT_TYPES field order", () => {
  it("matches v2.9 typehash order + types (9 fields)", () => {
    expect(VOTE_INTENT_TYPES.VoteIntent).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "voter", type: "address" },
      { name: "allocationsHash", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
      { name: "stakeAmount", type: "uint256" },
      { name: "feeShares", type: "FeeShare[]" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
  });

  it("typehash text matches the v2.9 cross-stack invariant", () => {
    const text =
      "VoteIntent(bytes32 questionId,address voter,bytes32 allocationsHash,uint256 feeAmount,uint256 stakeAmount,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
      "FeeShare(address recipient,uint256 basisPoints)";
    expect(keccak256(stringToBytes(text))).toBe(
      "0xce846377b54778704a6c695296cc69e3ebdfc08f87a6ef80f5fa07c7db946e2a",
    );
  });
});

describe("canonicalizeAllocations", () => {
  it("sorts by solutionId ASC", () => {
    const out = canonicalizeAllocations([
      { solutionId: "sol_B", points: 30 },
      { solutionId: "sol_A", points: 70 },
    ]);
    expect(out.json).toBe(
      '[{"solutionId":"sol_A","points":70},{"solutionId":"sol_B","points":30}]',
    );
  });

  it("emits solutionId key before points key", () => {
    const out = canonicalizeAllocations([{ solutionId: "x", points: 5 }]);
    expect(out.json).toBe('[{"solutionId":"x","points":5}]');
  });

  it("emits no whitespace", () => {
    const out = canonicalizeAllocations([
      { solutionId: "a", points: 1 },
      { solutionId: "b", points: 2 },
    ]);
    expect(out.json).not.toMatch(/\s/);
  });

  it("empty array → []", () => {
    expect(canonicalizeAllocations([]).json).toBe("[]");
  });

  it("escapes JSON-unsafe characters in solutionId via JSON.stringify", () => {
    const out = canonicalizeAllocations([
      { solutionId: 'sol_"wat"', points: 1 },
    ]);
    expect(out.json).toContain('"sol_\\"wat\\""');
  });
});

describe("computeAllocationsHash", () => {
  // The salt is mixed into the keccak; the pre-salt pinned vector
  // is invalid. Cross-language re-pinning happens once Go + UI + SDK
  // agree on a salted vector — until then we test internal
  // consistency + privacy properties.
  const SALT_A =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
  const SALT_B =
    "0x0000000000000000000000000000000000000000000000000000000000000002" as const;

  it("is deterministic for the same (allocations, salt)", () => {
    const allocs: Allocation[] = [
      { solutionId: "sol_B", points: 30 },
      { solutionId: "sol_A", points: 70 },
    ];
    expect(computeAllocationsHash(allocs, SALT_A)).toBe(
      computeAllocationsHash(allocs, SALT_A),
    );
  });

  it("differs when only the salt differs (privacy property)", () => {
    const allocs: Allocation[] = [{ solutionId: "sol_A", points: 100 }];
    expect(computeAllocationsHash(allocs, SALT_A)).not.toBe(
      computeAllocationsHash(allocs, SALT_B),
    );
  });

  it("is insensitive to caller-side input order", () => {
    const a = computeAllocationsHash(
      [
        { solutionId: "sol_A", points: 70 },
        { solutionId: "sol_B", points: 30 },
      ],
      SALT_A,
    );
    const b = computeAllocationsHash(
      [
        { solutionId: "sol_B", points: 30 },
        { solutionId: "sol_A", points: 70 },
      ],
      SALT_A,
    );
    expect(a).toBe(b);
  });

  it("differs when points change (avalanche)", () => {
    const a = computeAllocationsHash([{ solutionId: "x", points: 1 }], SALT_A);
    const b = computeAllocationsHash([{ solutionId: "x", points: 2 }], SALT_A);
    expect(a).not.toBe(b);
  });

  it("rejects malformed salt", () => {
    expect(() =>
      computeAllocationsHash([{ solutionId: "x", points: 1 }], "0xab" as `0x${string}`),
    ).toThrow(/32 bytes/);
  });
});

describe("validateAllocations", () => {
  it("accepts a valid list", () => {
    expect(() =>
      validateAllocations([
        { solutionId: "sol_A", points: 10 },
        { solutionId: "sol_B", points: 0 },
      ]),
    ).not.toThrow();
  });

  it("rejects empty solutionId", () => {
    expect(() => validateAllocations([{ solutionId: "", points: 1 }])).toThrow(
      /empty or non-string/,
    );
  });

  it("rejects non-integer points", () => {
    expect(() =>
      validateAllocations([{ solutionId: "x", points: 1.5 }]),
    ).toThrow(/non-negative integer/);
  });

  it("rejects negative points", () => {
    expect(() =>
      validateAllocations([{ solutionId: "x", points: -1 }]),
    ).toThrow(/non-negative integer/);
  });

  it("rejects duplicate solutionIds", () => {
    expect(() =>
      validateAllocations([
        { solutionId: "x", points: 1 },
        { solutionId: "x", points: 2 },
      ]),
    ).toThrow(/duplicate solutionId/);
  });
});

describe("buildVoteIntentTypedData", () => {
  const NOW = 1_714_000_000;
  const ALLOC_HASH =
    "0x5cbf670de3ba3eaf83b9f1c947eebe3eaa632f5cf32c2d76ecc8eb8bfb59993c" as const;
  const policy = defaultFeeSharePolicy(VOTER);

  it("composes the v2.5 EIP-712 domain from preflight", () => {
    const td = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.domain.name).toBe(FORGE_DOMAIN_NAME);
    expect(td.domain.version).toBe(FORGE_DOMAIN_VERSION);
    expect(td.domain.chainId).toBe(BigInt("84532"));
    expect(td.domain.verifyingContract).toBe(ROUTER);
    expect(td.primaryType).toBe("VoteIntent");
  });

  it("pulls fee + stake + nonce from preflight with overrides", () => {
    const base = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(base.message.feeAmount).toBe(BigInt("100000"));
    expect(base.message.stakeAmount).toBe(BigInt("1000000"));
    expect(base.message.nonce).toBe(BigInt("3"));

    const overridden = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShares: policy.shares,
      feeAmount: BigInt("42"),
      stakeAmount: BigInt("43"),
      nonce: BigInt("44"),
      nowSeconds: NOW,
    });
    expect(overridden.message.feeAmount).toBe(BigInt("42"));
    expect(overridden.message.stakeAmount).toBe(BigInt("43"));
    expect(overridden.message.nonce).toBe(BigInt("44"));
  });

  it("carries fee-share policy verbatim", () => {
    const td = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShares: [{ recipient: VOTER, basisPoints: BigInt(10000) }],
      nowSeconds: NOW,
    });
    // v2.9: per-intent feeShareBps removed (Q-level only).
    expect("feeShareBps" in td.message).toBe(false);
    expect(td.message.feeShares).toEqual([
      { recipient: VOTER, basisPoints: BigInt(10000) },
    ]);
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.message.expiresAt).toBe(BigInt(NOW + DEFAULT_VOTE_TTL_SECONDS));
  });
});

describe("buildSubmitVoteIntentRequestBody", () => {
  const policy = defaultFeeSharePolicy(VOTER);
  it("renders numerics + fee-share + canonical allocations", () => {
    const td = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash:
        "0x5cbf670de3ba3eaf83b9f1c947eebe3eaa632f5cf32c2d76ecc8eb8bfb59993c",
      feeShares: policy.shares,
      nowSeconds: 1_714_000_000,
    });
    const body = buildSubmitVoteIntentRequestBody({
      typedData: td,
      allocations: [
        { solutionId: "sol_A", points: 70 },
        { solutionId: "sol_B", points: 30 },
      ],
      signature: "0xbeef" as `0x${string}`,
      voteSalt:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      voteSaltToken: "0xtoken" as `0x${string}`,
    });
    expect(body.questionId).toBe(QID);
    expect(body.voter).toBe(VOTER);
    expect(body.feeAmount).toBe("100000");
    expect(body.stakeAmount).toBe("1000000");
    // v2.9: per-intent feeShareBps removed.
    expect("feeShareBps" in body).toBe(false);
    expect(body.feeShares).toEqual([
      { recipient: VOTER, basisPoints: "10000" },
    ]);
    expect(body.nonce).toBe("3");
    expect(body.chainId).toBe("84532");
    expect(body.expiresAt).toBe(
      String(1_714_000_000 + DEFAULT_VOTE_TTL_SECONDS),
    );
    expect(body.signature).toBe("0xbeef");
    expect(body.allocations).toEqual([
      { solutionId: "sol_A", points: 70 },
      { solutionId: "sol_B", points: 30 },
    ]);
    expect(body.voteSalt).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(body.voteSaltToken).toBe("0xtoken");
  });
});
