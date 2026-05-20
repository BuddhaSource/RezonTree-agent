// sponsor-witness.ts — Quadphase v2 SponsorWitness builder.
//
// Carries the per-question parameter set bound at sponsor() time:
// oracle, token floors, fees, stake basis points, fundingDeadline,
// noSolutionGracePeriod, content (title/body/criteria/tags).
//
// Field order MUST match contracts/src/QuadphaseTypes.sol::SponsorWitness
// and internal/protocol/witnesses.go::SponsorWitness byte-for-byte —
// any drift produces a contentHash the chain rejects at Stage-4.
//
// Drift fenced by:
//   - internal/signer/typehash_drift_test.go        (Go ↔ Solidity)
//   - internal/signer/polyglot_drift_test.go        (SDK ↔ UI; arity=13)

import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem";

export const SPONSOR_WITNESS_TYPES = {
  SponsorWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "title", type: "string" },
    { name: "body", type: "string" },
    { name: "criteria", type: "string" },
    { name: "tags", type: "string[]" },
    { name: "oracle", type: "address" },
    { name: "sponsorshipFloor", type: "uint256" },
    { name: "commitFee", type: "uint256" },
    { name: "voteFee", type: "uint256" },
    { name: "stakeFloor", type: "uint256" },
    { name: "stakeBasisPoints", type: "uint16" },
    { name: "fundingDeadline", type: "uint256" },
    { name: "noSolutionGracePeriod", type: "uint256" },
  ],
} as const;

export interface SponsorWitness {
  actionTag: number;
  title: string;
  body: string;
  criteria: string;
  tags: string[];
  oracle: Address;
  sponsorshipFloor: bigint;
  commitFee: bigint;
  voteFee: bigint;
  stakeFloor: bigint;
  stakeBasisPoints: number;
  fundingDeadline: bigint;
  noSolutionGracePeriod: bigint;
}

const SPONSOR_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "SponsorWitness(uint8 actionTag,string title,string body,string criteria,string[] tags,address oracle,uint256 sponsorshipFloor,uint256 commitFee,uint256 voteFee,uint256 stakeFloor,uint16 stakeBasisPoints,uint256 fundingDeadline,uint256 noSolutionGracePeriod)",
  ),
);

function hashStringArray(strs: string[]): Hex {
  const inner = strs
    .map((s) => keccak256(new TextEncoder().encode(s)).slice(2))
    .join("");
  return keccak256(("0x" + inner) as Hex);
}

/**
 * Builds a SponsorWitness from preflight params + agent-authored content.
 * Returns the witness object alongside its contentHash (= keccak of the
 * hashStruct) — the envelope template's `contentHash` field is set to
 * this value before signing.
 */
export function buildSponsorWitness(w: Omit<SponsorWitness, "actionTag">): {
  witness: SponsorWitness;
  contentHash: Hex;
} {
  const witness: SponsorWitness = {
    actionTag: 0, // ActionTag.Sponsor
    ...w,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint8, bytes32, bytes32, bytes32, bytes32, address, uint256, uint256, uint256, uint256, uint16, uint256, uint256",
      ),
      [
        SPONSOR_WITNESS_TYPEHASH,
        witness.actionTag,
        keccak256(new TextEncoder().encode(witness.title)),
        keccak256(new TextEncoder().encode(witness.body)),
        keccak256(new TextEncoder().encode(witness.criteria)),
        hashStringArray(witness.tags),
        witness.oracle,
        witness.sponsorshipFloor,
        witness.commitFee,
        witness.voteFee,
        witness.stakeFloor,
        witness.stakeBasisPoints,
        witness.fundingDeadline,
        witness.noSolutionGracePeriod,
      ],
    ),
  );
  return { witness, contentHash };
}
