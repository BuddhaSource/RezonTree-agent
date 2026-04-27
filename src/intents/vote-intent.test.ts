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
//   1. Allocations canonical encoding — sorted-by-solution_id
//      ASC, JSON object with solution_id-then-points keys, no
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
    recommended_fee: "100000",
    recommended_bond: "1000000",
    token: {
      contract_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      symbol: "USDC",
      chain_id: 84532,
    },
    router_address: ROUTER,
    chain_id: 84532,
    nonce_next: "3",
    _actions: [],
    ...overrides,
  };
}

describe("VOTE_INTENT_TYPES field order", () => {
  it("matches v2.5 typehash order + types (10 fields)", () => {
    expect(VOTE_INTENT_TYPES.VoteIntent).toEqual([
      { name: "questionId", type: "bytes32" },
      { name: "voter", type: "address" },
      { name: "allocationsHash", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
      { name: "bondAmount", type: "uint256" },
      { name: "feeShareBps", type: "uint256" },
      { name: "feeShares", type: "FeeShare[]" },
      { name: "nonce", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ]);
  });

  it("typehash text matches the pinned cross-stack invariant", () => {
    const text =
      "VoteIntent(bytes32 questionId,address voter,bytes32 allocationsHash,uint256 feeAmount,uint256 bondAmount,uint256 feeShareBps,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
      "FeeShare(address recipient,uint256 basisPoints)";
    expect(keccak256(stringToBytes(text)).startsWith("0x48aa")).toBe(true);
  });
});

describe("canonicalizeAllocations", () => {
  it("sorts by solution_id ASC", () => {
    const out = canonicalizeAllocations([
      { solution_id: "sol_B", points: 30 },
      { solution_id: "sol_A", points: 70 },
    ]);
    expect(out.json).toBe(
      '[{"solution_id":"sol_A","points":70},{"solution_id":"sol_B","points":30}]',
    );
  });

  it("emits solution_id key before points key", () => {
    const out = canonicalizeAllocations([{ solution_id: "x", points: 5 }]);
    expect(out.json).toBe('[{"solution_id":"x","points":5}]');
  });

  it("emits no whitespace", () => {
    const out = canonicalizeAllocations([
      { solution_id: "a", points: 1 },
      { solution_id: "b", points: 2 },
    ]);
    expect(out.json).not.toMatch(/\s/);
  });

  it("empty array → []", () => {
    expect(canonicalizeAllocations([]).json).toBe("[]");
  });

  it("escapes JSON-unsafe characters in solution_id via JSON.stringify", () => {
    const out = canonicalizeAllocations([
      { solution_id: 'sol_"wat"', points: 1 },
    ]);
    expect(out.json).toContain('"sol_\\"wat\\""');
  });
});

describe("computeAllocationsHash", () => {
  it("matches the pinned keccak vector for sol_A:70 + sol_B:30", () => {
    const allocs: Allocation[] = [
      { solution_id: "sol_B", points: 30 },
      { solution_id: "sol_A", points: 70 },
    ];
    expect(computeAllocationsHash(allocs)).toBe(
      "0x5cbf670de3ba3eaf83b9f1c947eebe3eaa632f5cf32c2d76ecc8eb8bfb59993c",
    );
  });

  it("matches the pinned keccak vector for the empty array", () => {
    expect(computeAllocationsHash([])).toBe(
      "0x518674ab2b227e5f11e9084f615d57663cde47bce1ba168b4c19c7ee22a73d70",
    );
  });

  it("is insensitive to caller-side input order", () => {
    const a = computeAllocationsHash([
      { solution_id: "sol_A", points: 70 },
      { solution_id: "sol_B", points: 30 },
    ]);
    const b = computeAllocationsHash([
      { solution_id: "sol_B", points: 30 },
      { solution_id: "sol_A", points: 70 },
    ]);
    expect(a).toBe(b);
  });

  it("differs when points change (avalanche)", () => {
    const a = computeAllocationsHash([{ solution_id: "x", points: 1 }]);
    const b = computeAllocationsHash([{ solution_id: "x", points: 2 }]);
    expect(a).not.toBe(b);
  });
});

describe("validateAllocations", () => {
  it("accepts a valid list", () => {
    expect(() =>
      validateAllocations([
        { solution_id: "sol_A", points: 10 },
        { solution_id: "sol_B", points: 0 },
      ]),
    ).not.toThrow();
  });

  it("rejects empty solution_id", () => {
    expect(() => validateAllocations([{ solution_id: "", points: 1 }])).toThrow(
      /empty or non-string/,
    );
  });

  it("rejects non-integer points", () => {
    expect(() =>
      validateAllocations([{ solution_id: "x", points: 1.5 }]),
    ).toThrow(/non-negative integer/);
  });

  it("rejects negative points", () => {
    expect(() =>
      validateAllocations([{ solution_id: "x", points: -1 }]),
    ).toThrow(/non-negative integer/);
  });

  it("rejects duplicate solution_ids", () => {
    expect(() =>
      validateAllocations([
        { solution_id: "x", points: 1 },
        { solution_id: "x", points: 2 },
      ]),
    ).toThrow(/duplicate solution_id/);
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
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(td.domain.name).toBe(FORGE_DOMAIN_NAME);
    expect(td.domain.version).toBe(FORGE_DOMAIN_VERSION);
    expect(td.domain.chainId).toBe(BigInt("84532"));
    expect(td.domain.verifyingContract).toBe(ROUTER);
    expect(td.primaryType).toBe("VoteIntent");
  });

  it("pulls fee + bond + nonce from preflight with overrides", () => {
    const base = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: NOW,
    });
    expect(base.message.feeAmount).toBe(BigInt("100000"));
    expect(base.message.bondAmount).toBe(BigInt("1000000"));
    expect(base.message.nonce).toBe(BigInt("3"));

    const overridden = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      feeWei: BigInt("42"),
      bondWei: BigInt("43"),
      nonce: BigInt("44"),
      nowSeconds: NOW,
    });
    expect(overridden.message.feeAmount).toBe(BigInt("42"));
    expect(overridden.message.bondAmount).toBe(BigInt("43"));
    expect(overridden.message.nonce).toBe(BigInt("44"));
  });

  it("carries fee-share policy verbatim", () => {
    const td = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShareBps: BigInt(1),
      feeShares: [{ recipient: VOTER, basisPoints: BigInt(10000) }],
      nowSeconds: NOW,
    });
    expect(td.message.feeShareBps).toBe(BigInt(1));
    expect(td.message.feeShares).toEqual([
      { recipient: VOTER, basisPoints: BigInt(10000) },
    ]);
  });

  it("defaults expiresAt to now + 10min", () => {
    const td = buildVoteIntentTypedData({
      preflight: preflight(),
      voter: VOTER,
      allocationsHash: ALLOC_HASH,
      feeShareBps: policy.bps,
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
      feeShareBps: policy.bps,
      feeShares: policy.shares,
      nowSeconds: 1_714_000_000,
    });
    const body = buildSubmitVoteIntentRequestBody({
      typedData: td,
      allocations: [
        { solution_id: "sol_A", points: 70 },
        { solution_id: "sol_B", points: 30 },
      ],
      signature: "0xbeef" as `0x${string}`,
    });
    expect(body.question_id).toBe(QID);
    expect(body.voter).toBe(VOTER);
    expect(body.fee_amount).toBe("100000");
    expect(body.bond_amount).toBe("1000000");
    expect(body.fee_share_bps).toBe("1");
    expect(body.fee_shares).toEqual([
      { recipient: VOTER, basis_points: "10000" },
    ]);
    expect(body.nonce).toBe("3");
    expect(body.chain_id).toBe("84532");
    expect(body.expires_at).toBe(
      String(1_714_000_000 + DEFAULT_VOTE_TTL_SECONDS),
    );
    expect(body.signature).toBe("0xbeef");
    expect(body.allocations).toEqual([
      { solution_id: "sol_A", points: 70 },
      { solution_id: "sol_B", points: 30 },
    ]);
  });
});
