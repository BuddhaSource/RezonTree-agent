// cosponsor-witness.ts — Quadphase v2 CosponsorWitness builder.
//
// Per-cosponsor amount payload. The `amount` MUST equal
// envelope.funds.poolIn (rev2 §10.2 H3-econ: prevents single-hash
// collision across cosponsor logs).
//
// Drift fenced by polyglot_drift_test (arity=2).

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const COSPONSOR_WITNESS_TYPES = {
  CosponsorWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "amount", type: "uint256" },
  ],
} as const;

export interface CosponsorWitness {
  actionTag: number;
  amount: bigint;
}

const COSPONSOR_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "CosponsorWitness(uint8 actionTag,uint256 amount)",
  ),
);

export function buildCosponsorWitness(params: { amount: bigint }): {
  witness: CosponsorWitness;
  contentHash: Hex;
} {
  const witness: CosponsorWitness = {
    actionTag: 1, // ActionTag.Cosponsor
    amount: params.amount,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint8, uint256"),
      [COSPONSOR_WITNESS_TYPEHASH, witness.actionTag, witness.amount],
    ),
  );
  return { witness, contentHash };
}
