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
} from "../quadphase-flow.js";

// NOTE: runClaimFlow is NOT in this drift fence. Claim is now
// PERMISSIONLESS + UNSIGNED (contract A+G) — it builds no envelope,
// signs nothing, and asserts no intentHash (the Merkle proof is the
// authorisation). There is no "sign past drift" hazard to fence.

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
        // No feeShares param — cosponsor hardcodes empty feeShares +
        // feeShareBps=0 (the fix for the Round-3 envelope drift). The
        // shape-match test below asserts the resulting funds.
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

  it("never reaches fetch — assertion is strictly pre-network", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── Round-3 submit-body shape parity (sponsor ≡ cosponsor) ──────────
//
// Regression fence for the Q9 cosponsor crash: runCosponsorFlow posted a
// body that drifted from runSponsorFlow's correct Round-3 shape. This
// runs both flows far enough to capture the POST body (the broadcast
// step never runs — the stub wallet would throw — so we let the POST
// reject AFTER capture). We assert:
//   1. Both bodies carry the identical top-level Round-3 field set
//      ({actionType, typedData, content, signature, expectedIntentHash}).
//   2. Cosponsor's actionType is "cosponsor".
//   3. Cosponsor's funds.feeShares is the EMPTY array and feeShareBps=0
//      (the #656 invariant — frozen by the first sponsor; chain shape
//      gate + backend preflight bake empty).
describe("Round-3 submit body: cosponsor mirrors sponsor's shape", () => {
  const base = {
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

  // Capture the POST body, then fail the response so the flow throws
  // before reaching the (stub) broadcast leg.
  function captureFetch(): { bodies: unknown[] } {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _url: unknown,
      init?: { body?: string },
    ) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return {
        ok: false,
        status: 599,
        statusText: "captured",
        text: async () => "captured-by-test",
      } as unknown as Response;
    }) as typeof fetch);
    return { bodies };
  }

  it("posts the same top-level field set, actionType=cosponsor, empty feeShares", async () => {
    const cap = captureFetch();

    // Sponsor — pass the local hash as expectedIntentHash so the drift
    // assert no-ops and the flow reaches the POST. We don't care about
    // the hash value, only the body shape.
    await runSponsorFlow({
      ...base,
      expectedIntentHash: undefined as unknown as Hex,
      title: "T", body: "B", criteria: "C", tags: [],
      oracle: ORACLE,
      sponsorshipFloor: 1n, commitFee: 1n, voteFee: 0n,
      stakeFloor: 0n, stakeBasisPoints: 0,
      fundingDeadline: base.expiresAt, noSolutionGracePeriod: 1800n,
      token: TOKEN, amount: 1n, feeAmount: 0n, feeShareBps: 0, feeShares: [],
    }).catch(() => undefined);

    await runCosponsorFlow({
      ...base,
      expectedIntentHash: undefined as unknown as Hex,
      token: TOKEN, amount: 1n, feeAmount: 0n,
    }).catch(() => undefined);

    expect(cap.bodies).toHaveLength(2);
    const [sponsorBody, cosponsorBody] = cap.bodies as Array<Record<string, unknown>>;

    // 1. Identical top-level Round-3 field set — this is the load-bearing
    //    parity assertion (the Q9 crash was the two bodies drifting apart).
    //    `expectedIntentHash` is undefined here (we skip the drift assert),
    //    so stringifyWithBigInts omits it from BOTH bodies symmetrically;
    //    the remaining four keys are the Round-3 shape.
    expect(Object.keys(cosponsorBody).sort()).toEqual(
      Object.keys(sponsorBody).sort(),
    );
    expect(Object.keys(cosponsorBody).sort()).toEqual(
      ["actionType", "content", "signature", "typedData"],
    );

    // 2. Discriminator.
    expect(cosponsorBody.actionType).toBe("cosponsor");
    expect(sponsorBody.actionType).toBe("sponsor");

    // 3. #656 invariant — cosponsor carries empty feeShares + feeShareBps=0.
    const coFunds = (cosponsorBody.typedData as { funds: Record<string, unknown> }).funds;
    expect(coFunds.feeShares).toEqual([]);
    expect(coFunds.feeShareBps).toBe(0);
  });
});
