// claim-witness.ts — Quadphase v2 ClaimWitness builder.
//
// Winner's pull-side payload with Merkle proof + role discriminator.
// Dual-role winners (solver who voted on their own solution) claim two
// disjoint leaves; the `role` byte makes them distinct.
//
// Drift fenced by polyglot_drift_test (arity=6).

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const CLAIM_WITNESS_TYPES = {
  ClaimWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "proof", type: "bytes32[]" },
    { name: "leafIndex", type: "uint256" },
    { name: "leafAmount", type: "uint256" },
    { name: "role", type: "uint8" },
    { name: "expectedStatus", type: "uint8" },
  ],
} as const;

export interface ClaimWitness {
  actionTag: number;
  proof: Hex[];
  leafIndex: bigint;
  leafAmount: bigint;
  role: number;
  expectedStatus: number;
}

const CLAIM_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "ClaimWitness(uint8 actionTag,bytes32[] proof,uint256 leafIndex,uint256 leafAmount,uint8 role,uint8 expectedStatus)",
  ),
);

function hashBytes32Array(arr: Hex[]): Hex {
  const concat = arr.map((h) => h.slice(2)).join("");
  return keccak256(("0x" + concat) as Hex);
}

export function buildClaimWitness(w: Omit<ClaimWitness, "actionTag">): {
  witness: ClaimWitness;
  contentHash: Hex;
} {
  const witness: ClaimWitness = {
    actionTag: 5, // ActionTag.Claim
    ...w,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint8, bytes32, uint256, uint256, uint8, uint8",
      ),
      [
        CLAIM_WITNESS_TYPEHASH,
        witness.actionTag,
        hashBytes32Array(witness.proof),
        witness.leafIndex,
        witness.leafAmount,
        witness.role,
        witness.expectedStatus,
      ],
    ),
  );
  return { witness, contentHash };
}
