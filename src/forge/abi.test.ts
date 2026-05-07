// abi.test.ts — pins the RezonForge ABI shape as a cross-language
// contract. Any rename / reorder on RezonForge.sol must mirror here;
// the test catches drift at SDK-test time instead of at
// on-chain-revert time.

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

describe("REZON_FORGE_ABI shape", () => {
  it("exports the agent-writable functions", () => {
    expect(FORGE_WRITE_FUNCTIONS).toEqual([
      "sponsor",
      "cosponsor",
      "commitSolution",
      "castVote",
      "claim",
    ]);
  });

  it("sponsor tuple matches SponsorIntent struct (19 fields in typehash order)", () => {
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
      "commitFee",
      "noSolutionGracePeriod",
      "feeShareBps",
      "platformFeeRecipient",
      "abandonmentGracePeriod",
      // sponsor-signed funding-window deadline; sits between
      // abandonmentGracePeriod and sponsor in the contract struct.
      "fundingDeadline",
      "sponsor",
      "amount",
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("cosponsor tuple matches CosponsorIntent struct (7 fields)", () => {
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
      // Per-intent feeShareBps is not part of the tuple (Q-level only).
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("commitSolution tuple matches CommitIntent struct (9 fields)", () => {
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
      // Per-intent feeShareBps is not part of the tuple (Q-level only).
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("castVote tuple matches VoteIntent struct (9 fields)", () => {
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
      // Per-intent feeShareBps is not part of the tuple (Q-level only).
      "feeShares",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("claim takes (qid, recipient, amount, proof) — executor-callable", () => {
    const fn = findFunction("claim");
    expect(fn!.inputs.map((i) => i.name)).toEqual([
      "questionId",
      "recipient",
      "amount",
      "proof",
    ]);
    expect(fn!.inputs.map((i) => i.type)).toEqual([
      "bytes32",
      "address",
      "uint256",
      "bytes32[]",
    ]);
  });

  it("claimAllForQuestion takes a recipient parameter", () => {
    const fn = findFunction("claimAllForQuestion");
    expect(fn!.inputs.map((i) => i.name)).toEqual([
      "questionId",
      "recipient",
      "poolAmount",
      "poolProof",
      "solutionIntentHash",
      "voteIntentHash",
    ]);
  });

  it("claimPendingShares takes (recipient, token, amount) — executor-callable", () => {
    const fn = findFunction("claimPendingShares");
    expect(fn!.inputs.map((i) => i.name)).toEqual([
      "recipient",
      "token",
      "amount",
    ]);
    expect(fn!.inputs.map((i) => i.type)).toEqual([
      "address",
      "address",
      "uint256",
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
