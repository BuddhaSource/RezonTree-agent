// abi.test.ts — pins the Router v2 ABI shape as a cross-language
// contract. Any rename / reorder on Router.sol must mirror here;
// the test catches drift at SDK-test time instead of at
// on-chain-revert time.

import { describe, expect, it } from "vitest";
import {
  ROUTER_V2_ABI,
  ROUTER_WRITE_FUNCTIONS,
  type RouterWriteFunction,
} from "./abi.js";

function findFunction(name: string) {
  return ROUTER_V2_ABI.find(
    (item) => item.type === "function" && item.name === name,
  );
}

describe("ROUTER_V2_ABI shape", () => {
  it("exports exactly 4 agent-writable functions", () => {
    expect(ROUTER_WRITE_FUNCTIONS).toEqual([
      "fund",
      "commitSolution",
      "castVote",
      "claim",
    ]);
  });

  it("fund tuple matches FundIntent struct (6 fields in typehash order)", () => {
    const fund = findFunction("fund");
    expect(fund).toBeDefined();
    const intentInput = fund!.inputs[0] as {
      type: string;
      components: { name: string; type: string }[];
    };
    expect(intentInput.type).toBe("tuple");
    expect(intentInput.components.map((c) => c.name)).toEqual([
      "questionId",
      "funder",
      "amount",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
    expect(intentInput.components.map((c) => c.type)).toEqual([
      "bytes32",
      "address",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
    ]);
  });

  it("commitSolution tuple matches CommitIntent struct (8 fields)", () => {
    const fn = findFunction("commitSolution");
    const intentInput = fn!.inputs[0] as {
      components: { name: string; type: string }[];
    };
    expect(intentInput.components.map((c) => c.name)).toEqual([
      "questionId",
      "submitter",
      "contentHash",
      "feeAmount",
      "bondAmount",
      "nonce",
      "chainId",
      "expiresAt",
    ]);
  });

  it("castVote tuple matches VoteIntent struct (8 fields)", () => {
    const fn = findFunction("castVote");
    const intentInput = fn!.inputs[0] as {
      components: { name: string; type: string }[];
    };
    expect(intentInput.components.map((c) => c.name)).toEqual([
      "questionId",
      "voter",
      "allocationsHash",
      "feeAmount",
      "bondAmount",
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

  it("write functions all expect (intent, intentSig, permitV, permitR, permitS) shape (except claim)", () => {
    for (const name of ["fund", "commitSolution", "castVote"] as const) {
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
    for (const name of ROUTER_WRITE_FUNCTIONS) {
      const fn = findFunction(name);
      expect(fn!.stateMutability).toBe("nonpayable");
      expect(fn!.outputs).toEqual([]);
    }
  });

  it("RouterWriteFunction type is exported + inferable", () => {
    const valid: RouterWriteFunction = "fund";
    expect(valid).toBe("fund");
  });
});
