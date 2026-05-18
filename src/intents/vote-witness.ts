// vote-witness.ts — Quadphase v2 VoteWitness builder.
//
// Voter's allocation payload + privacy salt. The salt is server-issued
// at vote preflight (HMAC-bound; see vote_salt.ts in services/) and
// echoed verbatim into the witness — mixing it into the keccak prevents
// rainbow-table enumeration of voter allocations from on-chain
// VoteCast events.
//
// `Allocation` is a sub-type; the EIP-712 typestring places it AFTER
// the primary type per v4 alphabetical sub-type rule (Allocation before
// VoteWitness).
//
// Drift fenced by polyglot_drift_test (arity=3).

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const VOTE_WITNESS_TYPES = {
  Allocation: [
    { name: "solutionId", type: "bytes32" },
    { name: "basisPoints", type: "uint16" },
  ],
  VoteWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "allocations", type: "Allocation[]" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export interface Allocation {
  solutionId: Hex;
  basisPoints: number;
}

export interface VoteWitness {
  actionTag: number;
  allocations: Allocation[];
  salt: Hex;
}

const VOTE_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "VoteWitness(uint8 actionTag,Allocation[] allocations,bytes32 salt)Allocation(bytes32 solutionId,uint16 basisPoints)",
  ),
);

const ALLOCATION_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Allocation(bytes32 solutionId,uint16 basisPoints)",
  ),
);

function hashAllocation(a: Allocation): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, uint16"),
      [ALLOCATION_TYPEHASH, a.solutionId, a.basisPoints],
    ),
  );
}

function hashAllocationArray(allocs: Allocation[]): Hex {
  const concat = allocs.map((a) => hashAllocation(a).slice(2)).join("");
  return keccak256(("0x" + concat) as Hex);
}

export function buildVoteWitness(params: {
  allocations: Allocation[];
  salt: Hex;
}): { witness: VoteWitness; contentHash: Hex } {
  const witness: VoteWitness = {
    actionTag: 3, // ActionTag.Vote
    allocations: params.allocations,
    salt: params.salt,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint8, bytes32, bytes32"),
      [
        VOTE_WITNESS_TYPEHASH,
        witness.actionTag,
        hashAllocationArray(witness.allocations),
        witness.salt,
      ],
    ),
  );
  return { witness, contentHash };
}
