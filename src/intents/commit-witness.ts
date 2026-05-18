// commit-witness.ts — Quadphase v2 CommitWitness builder.
//
// Solution submission payload (free-form solutionBody + references).
// Field order matches contracts/src/QuadphaseTypes.sol::CommitWitness
// and internal/protocol/witnesses.go::CommitWitness.
//
// Drift fenced by polyglot_drift_test (arity=3).

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const COMMIT_WITNESS_TYPES = {
  CommitWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "solutionBody", type: "string" },
    { name: "references", type: "string[]" },
  ],
} as const;

export interface CommitWitness {
  actionTag: number;
  solutionBody: string;
  references: string[];
}

const COMMIT_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "CommitWitness(uint8 actionTag,string solutionBody,string[] references)",
  ),
);

function hashStringArray(strs: string[]): Hex {
  const inner = strs
    .map((s) => keccak256(new TextEncoder().encode(s)).slice(2))
    .join("");
  return keccak256(("0x" + inner) as Hex);
}

export function buildCommitWitness(params: {
  solutionBody: string;
  references: string[];
}): { witness: CommitWitness; contentHash: Hex } {
  const witness: CommitWitness = {
    actionTag: 2, // ActionTag.Commit
    solutionBody: params.solutionBody,
    references: params.references,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint8, bytes32, bytes32"),
      [
        COMMIT_WITNESS_TYPEHASH,
        witness.actionTag,
        keccak256(new TextEncoder().encode(witness.solutionBody)),
        hashStringArray(witness.references),
      ],
    ),
  );
  return { witness, contentHash };
}
