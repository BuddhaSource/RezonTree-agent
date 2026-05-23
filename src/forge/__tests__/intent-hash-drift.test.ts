// intent-hash-drift.test.ts — R-INTENT-HASH-IS-MATCH-KEY fence.
//
// Every chain-bound flow recomputes the EIP-712 intentHash locally
// from the constructed envelope and asserts equality with the
// preflight-asserted `expectedIntentHash` BEFORE signing. Mismatch
// is fatal — a signature past a drifted hash burns gas on an event
// the reconciler can't match.
//
// This test feeds each preflight-bearing flow an `expectedIntentHash`
// that deliberately doesn't match the envelope content. The flow
// MUST throw with `intent hash drift` before any signing or network
// I/O. We assert that by:
//
//   1. Passing stub walletClient / privateKey that would explode if
//      ever invoked (the assertion fires first, so neither runs).
//   2. Asserting no `fetch` is called (jsdom unset / vitest's default
//      env has no network — a fetch attempt would either reject or
//      hit our spy).
//
// Audit issue #618.

import { describe, expect, it, vi } from "vitest";
import type { Address, Hex, WalletClient } from "viem";

import {
  assertIntentHashMatch,
  runSponsorFlow,
  runCosponsorFlow,
  runCommitFlow,
  runVoteFlow,
  runRefundFlow,
  runClaimFlow,
} from "../quadphase-flow.js";

// A 32-byte hex that will never match any real envelope hash.
const BOGUS_HASH = ("0x" + "de".repeat(32)) as Hex;
const ZERO_HASH = ("0x" + "0".repeat(64)) as Hex;
// Deterministic test key (anvil default #0). Never holds funds —
// safe to commit. We never actually sign with it in this test
// because the drift assertion fires first.
const TEST_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FORGE: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x2222222222222222222222222222222222222222";
const ORACLE: Address = "0x3333333333333333333333333333333333333333";

// A wallet client that would throw if any method is invoked. The
// drift assertion runs before signing or broadcasting, so a thrown
// drift error proves the assertion ran first.
const stubWallet = new Proxy({} as WalletClient, {
  get(_t, k) {
    throw new Error(
      `stubWallet.${String(k)} accessed — assertion did not fire before signing!`,
    );
  },
});

describe("assertIntentHashMatch (pure helper)", () => {
  it("no-ops when expected is undefined", () => {
    expect(() => assertIntentHashMatch(undefined, BOGUS_HASH)).not.toThrow();
  });

  it("no-ops on case-insensitive match", () => {
    const lower = ("0x" + "ab".repeat(32)) as Hex;
    const upper = ("0x" + "AB".repeat(32)) as Hex;
    expect(() => assertIntentHashMatch(lower, upper)).not.toThrow();
  });

  it("throws on drift with a recovery-oriented message", () => {
    expect(() =>
      assertIntentHashMatch(BOGUS_HASH, ZERO_HASH),
    ).toThrowError(/intent hash drift/);
  });
});

describe("runXxxFlow refuses to sign past drift (R-INTENT-HASH-IS-MATCH-KEY)", () => {
  // Common chain/identity fields shared by every flow.
  const common = {
    baseUrl: "http://localhost:9999",
    bearerToken: "test-token",
    signer: TEST_ADDR,
    qid: ("0x" + "01".repeat(32)) as Hex,
    questionId: "qst_test",
    nonce: 0n,
    expiresAt: 9_999_999_999n,
    forgeAddress: FORGE,
    chainId: 31337,
    walletClient: stubWallet,
    privateKey: TEST_KEY,
  };

  // We additionally pin a fetch spy. If the drift assertion fails to
  // fire, the flow would attempt a POST — that's the second-level
  // proof the assertion came BEFORE any network call.
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error(
      "fetch invoked — drift assertion failed to fire before submit",
    );
  });

  it("runSponsorFlow throws on drift", async () => {
    await expect(
      runSponsorFlow({
        ...common,
        expectedIntentHash: BOGUS_HASH,
        title: "T",
        body: "B",
        criteria: "C",
        tags: [],
        oracle: ORACLE,
        sponsorshipFloor: 1n,
        commitFee: 1n,
        voteFee: 0n,
        stakeFloor: 0n,
        stakeBasisPoints: 0,
        fundingDeadline: common.expiresAt,
        noSolutionGracePeriod: 1800n,
        token: TOKEN,
        amount: 1n,
        feeAmount: 0n,
        feeShareBps: 0,
        feeShares: [],
      }),
    ).rejects.toThrow(/intent hash drift/);
  });

  it("runCosponsorFlow throws on drift", async () => {
    await expect(
      runCosponsorFlow({
        ...common,
        expectedIntentHash: BOGUS_HASH,
        token: TOKEN,
        amount: 1n,
        feeAmount: 0n,
        feeShareBps: 0,
        feeShares: [],
      }),
    ).rejects.toThrow(/intent hash drift/);
  });

  it("runCommitFlow throws on drift", async () => {
    await expect(
      runCommitFlow({
        ...common,
        expectedIntentHash: BOGUS_HASH,
        solutionBody: "answer",
        references: [],
        token: TOKEN,
        feeAmount: 1n,
        stakeAmount: 1n,
        feeShareBps: 0,
        feeShares: [],
      }),
    ).rejects.toThrow(/intent hash drift/);
  });

  it("runVoteFlow throws on drift", async () => {
    await expect(
      runVoteFlow({
        ...common,
        expectedIntentHash: BOGUS_HASH,
        allocations: [
          {
            solutionId: ("0x" + "aa".repeat(32)) as Hex,
            basisPoints: 10000,
          },
        ],
        voteSalt: ("0x" + "ff".repeat(32)) as Hex,
        voteSaltToken: ("0x" + "ee".repeat(32)) as Hex,
        token: TOKEN,
        feeAmount: 1n,
        stakeAmount: 1n,
        feeShareBps: 0,
        feeShares: [],
      }),
    ).rejects.toThrow(/intent hash drift/);
  });

  it("runRefundFlow throws on drift", async () => {
    await expect(
      runRefundFlow({
        ...common,
        expectedIntentHash: BOGUS_HASH,
        token: TOKEN,
        sourceIntentHash: ZERO_HASH,
        expectedAmount: 1n,
        expectedStatus: 4,
      }),
    ).rejects.toThrow(/intent hash drift/);
  });

  it("runClaimFlow throws on drift", async () => {
    await expect(
      runClaimFlow({
        ...common,
        expectedIntentHash: BOGUS_HASH,
        token: TOKEN,
        proof: [],
        leafIndex: 0n,
        leafAmount: 1n,
        role: 0,
        expectedStatus: 3,
      }),
    ).rejects.toThrow(/intent hash drift/);
  });

  it("never reaches fetch — assertion is strictly pre-network", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
