// refund-witness.ts — Quadphase v2 RefundWitness builder.
//
// Refund pull-side payload. `sourceIntentHash == 0x00..00` is the
// sentinel for the sponsor-refund path (sponsor's contribution refund
// after abandonment); non-zero sourceIntentHash refunds a specific
// commit/vote stake.
//
// Drift fenced by polyglot_drift_test (arity=4).

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const REFUND_WITNESS_TYPES = {
  RefundWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "sourceIntentHash", type: "bytes32" },
    { name: "expectedAmount", type: "uint256" },
    { name: "expectedStatus", type: "uint8" },
  ],
} as const;

export interface RefundWitness {
  actionTag: number;
  sourceIntentHash: Hex;
  expectedAmount: bigint;
  expectedStatus: number;
}

const REFUND_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "RefundWitness(uint8 actionTag,bytes32 sourceIntentHash,uint256 expectedAmount,uint8 expectedStatus)",
  ),
);

export function buildRefundWitness(w: Omit<RefundWitness, "actionTag">): {
  witness: RefundWitness;
  contentHash: Hex;
} {
  const witness: RefundWitness = {
    actionTag: 6, // ActionTag.Refund
    ...w,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint8, bytes32, uint256, uint8"),
      [
        REFUND_WITNESS_TYPEHASH,
        witness.actionTag,
        witness.sourceIntentHash,
        witness.expectedAmount,
        witness.expectedStatus,
      ],
    ),
  );
  return { witness, contentHash };
}
