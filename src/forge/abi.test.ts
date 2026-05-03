// abi.test.ts — pins the RezonForge v2.7 ABI shape as a
// cross-language contract. Any rename / reorder on RezonForge.sol
// must mirror here; the test catches drift at SDK-test time
// instead of at on-chain-revert time.

import { describe, expect, it } from "vitest";
import {
  REZON_FORGE_ABI,
  FORGE_WRITE_FUNCTIONS,
  type ForgeWriteFunction,
} from "./abi.js";

function findFunction(name: string) {
  return REZON_FORGE_ABI.find(
    (item) => item.type === "function" && item.name === name,
  );
}

describe("REZON_FORGE_ABI shape (v2.7)", () => {
  it("exports the v2.7 agent-writable functions", () => {
    expect(FORGE_WRITE_FUNCTIONS).toEqual([
      "sponsor",
      "cosponsor",
      "commitSolution",
      "castVote",
      "claim",
    ]);
  });

  it("sponsor tuple matches SponsorIntent struct (19 fields in typehash order, v2.7)", () => {
    const fn = findFunction("sponsor");
    expect(fn).toBeDefined();
    const intentInput = fn!.inputs[0] as {
      type: string;
      components: { name: string; type: string }[];
    };
    expect(intentInput.type).toBe("tuple");
    expect(intentInput.components.map((c) => c.name)).toEqual([
      "questionId",
      "oracle",
      "token",
      "stakeFloor",
      "stakeBasisPoints",
      "sponsorshipFloor",
      "voteFee",
      // v2.7 fields inserted after voteFee:
      "commitFee",
      "noSolutionGracePeriod",
      "platformFeeBps",
      "platformFeeRecipient",
      "abandonmentGracePeriod",
      "sponsor",
      "amount",
      "feeShareBps",
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("cosponsor tuple matches CosponsorIntent struct (8 fields)", () => {
    const fn = findFunction("cosponsor");
    expect(fn).toBeDefined();
    const intentInput = fn!.inputs[0] as {
      type: string;
      components: { name: string; type: string }[];
    };
    expect(intentInput.type).toBe("tuple");
    expect(intentInput.components.map((c) => c.name)).toEqual([
      "questionId",
      "sponsor",
      "amount",
      "feeShareBps",
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("commitSolution tuple matches v2.5 CommitIntent struct (10 fields)", () => {
    const fn = findFunction("commitSolution");
    const intentInput = fn!.inputs[0] as {
      components: { name: string; type: string }[];
    };
    expect(intentInput.components.map((c) => c.name)).toEqual([
      "questionId",
      "submitter",
      "contentHash",
      "feeAmount",
      "stakeAmount",
      "feeShareBps",
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("castVote tuple matches v2.5 VoteIntent struct (10 fields)", () => {
    const fn = findFunction("castVote");
    const intentInput = fn!.inputs[0] as {
      components: { name: string; type: string }[];
    };
    expect(intentInput.components.map((c) => c.name)).toEqual([
      "questionId",
      "voter",
      "allocationsHash",
      "feeAmount",
      "stakeAmount",
      "feeShareBps",
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("claim takes (bytes32 qid, uint256 amount, bytes32[] proof)", () => {
    const fn = findFunction("claim");
    expect(fn!.inputs.map((i) => i.name)).toEqual([
      "questionId",
      "amount",
      "proof",
    ]);
    expect(fn!.inputs.map((i) => i.type)).toEqual([
      "bytes32",
      "uint256",
      "bytes32[]",
    ]);
  });

  it("intent-bearing write functions share (intent, intentSig, permitV, permitR, permitS) shape", () => {
    for (const name of [
      "sponsor",
      "cosponsor",
      "commitSolution",
      "castVote",
    ] as const) {
      const fn = findFunction(name);
      expect(fn!.inputs.map((i) => i.name)).toEqual([
        "intent",
        "intentSig",
        "permitV",
        "permitR",
        "permitS",
      ]);
      expect(fn!.inputs.map((i) => i.type)).toEqual([
        "tuple",
        "bytes",
        "uint8",
        "bytes32",
        "bytes32",
      ]);
    }
  });

  it("each write function is declared nonpayable + no outputs", () => {
    for (const name of FORGE_WRITE_FUNCTIONS) {
      const fn = findFunction(name);
      expect(fn!.stateMutability).toBe("nonpayable");
      expect(fn!.outputs).toEqual([]);
    }
  });

  it("ForgeWriteFunction type is exported + inferable", () => {
    const valid: ForgeWriteFunction = "sponsor";
    expect(valid).toBe("sponsor");
  });
});
