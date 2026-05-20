// abandon-witness.ts — Quadphase v2 AbandonWitness builder.
//
// Permissionless Open → Abandoned transition (rev2 §10.1 C1-sm).
// `reason` mirrors questions.abandonment_reason
// ('timeout' / 'no_solutions' / 'owner_cancelled') encoded as a bytes32
// string. Permissionless after q.abandonmentEligibleAt; chain enforces
// the timestamp.
//
// Drift fenced by polyglot_drift_test (arity=3).

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const ABANDON_WITNESS_TYPES = {
  AbandonWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "expectedStatus", type: "uint8" },
    { name: "reason", type: "bytes32" },
  ],
} as const;

export interface AbandonWitness {
  actionTag: number;
  expectedStatus: number;
  reason: Hex;
}

const ABANDON_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "AbandonWitness(uint8 actionTag,uint8 expectedStatus,bytes32 reason)",
  ),
);

export function buildAbandonWitness(w: Omit<AbandonWitness, "actionTag">): {
  witness: AbandonWitness;
  contentHash: Hex;
} {
  const witness: AbandonWitness = {
    actionTag: 7, // ActionTag.Abandon
    ...w,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint8, uint8, bytes32"),
      [
        ABANDON_WITNESS_TYPEHASH,
        witness.actionTag,
        witness.expectedStatus,
        witness.reason,
      ],
    ),
  );
  return { witness, contentHash };
}
