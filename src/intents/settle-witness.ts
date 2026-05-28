// settle-witness.ts — Quadphase v2 SettleWitness builder.
//
// Oracle's settlement publication payload. Supports chunked publishing
// via slashEntryOffset / totalSlashEntries; the final chunk carries the
// merkleRoot + totalClaimable that enables claims.
//
// Fee-model (economics.md §0, design-locked 2026-05-27): the realized-
// outcome fee is taken once at settlement. The oracle aggregates each
// participant's fee (win→winnings, lose→forfeited stake, sponsor→
// contribution) by recipient into `feeDistributions[]` and attests the
// total in `feeTotal` (renamed from the pre-revision `dustFolded`). The
// contract pins `feeTotal == poolAmount × q.feeShareBps / 10000`, requires
// `feeDistributions[0].recipient == q.feeShares[0]` (platform), and credits
// each entry to `accruedFees[recipient][token]` — replacing the single-sink
// `dustFolded → feeShares[0]` fold of the old model.
//
// `SlashEntry` + `FeeDistribution` are sub-types; EIP-712 v4 orders
// referenced sub-types alphabetically AFTER the primary type, so the
// typestring lists `FeeDistribution` before `SlashEntry`.
//
// 3-stack fence: contracts/src/QuadphaseTypes.sol SETTLE_WITNESS_TYPESTRING
// ↔ internal/signer/quadphase_envelope.go SettleWitnessTypeString ↔ this
// file. typehash-strict.test.ts pins the literal hex against drift; the
// shared golden vectors (testdata/envelope-vectors.json) cross-check the
// contentHash against the backend byte-for-byte.

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const SETTLE_WITNESS_TYPES = {
  SettleWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "merkleRoot", type: "bytes32" },
    { name: "totalClaimable", type: "uint256" },
    { name: "feeTotal", type: "uint256" },
    { name: "slashes", type: "SlashEntry[]" },
    { name: "leafCount", type: "uint256" },
    { name: "slashEntryOffset", type: "uint256" },
    { name: "totalSlashEntries", type: "uint256" },
    { name: "feeDistributions", type: "FeeDistribution[]" },
  ],
  FeeDistribution: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  SlashEntry: [
    { name: "intentHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "role", type: "uint8" },
  ],
} as const;

export interface SlashEntry {
  intentHash: Hex;
  amount: bigint;
  role: number;
}

export interface FeeDistribution {
  recipient: Hex;
  amount: bigint;
}

export interface SettleWitness {
  actionTag: number;
  merkleRoot: Hex;
  totalClaimable: bigint;
  feeTotal: bigint;
  slashes: SlashEntry[];
  leafCount: bigint;
  slashEntryOffset: bigint;
  totalSlashEntries: bigint;
  feeDistributions: FeeDistribution[];
}

// Sub-types ordered alphabetically (FeeDistribution before SlashEntry) per
// EIP-712 v4 — byte-identical to QuadphaseTypes.sol + quadphase_envelope.go.
const SETTLE_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "SettleWitness(uint8 actionTag,bytes32 merkleRoot,uint256 totalClaimable,uint256 feeTotal,SlashEntry[] slashes,uint256 leafCount,uint256 slashEntryOffset,uint256 totalSlashEntries,FeeDistribution[] feeDistributions)" +
      "FeeDistribution(address recipient,uint256 amount)" +
      "SlashEntry(bytes32 intentHash,uint256 amount,uint8 role)",
  ),
);

const SLASH_ENTRY_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "SlashEntry(bytes32 intentHash,uint256 amount,uint8 role)",
  ),
);

const FEE_DISTRIBUTION_TYPEHASH = keccak256(
  new TextEncoder().encode("FeeDistribution(address recipient,uint256 amount)"),
);

function hashSlashEntry(s: SlashEntry): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, uint256, uint8"),
      [SLASH_ENTRY_TYPEHASH, s.intentHash, s.amount, s.role],
    ),
  );
}

function hashSlashes(slashes: SlashEntry[]): Hex {
  const concat = slashes.map((s) => hashSlashEntry(s).slice(2)).join("");
  return keccak256(("0x" + concat) as Hex);
}

function hashFeeDistribution(f: FeeDistribution): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, uint256"), [
      FEE_DISTRIBUTION_TYPEHASH,
      f.recipient,
      f.amount,
    ]),
  );
}

function hashFeeDistributions(fees: FeeDistribution[]): Hex {
  const concat = fees.map((f) => hashFeeDistribution(f).slice(2)).join("");
  return keccak256(("0x" + concat) as Hex);
}

export function buildSettleWitness(w: Omit<SettleWitness, "actionTag">): {
  witness: SettleWitness;
  contentHash: Hex;
} {
  const witness: SettleWitness = {
    actionTag: 4, // ActionTag.Settle
    ...w,
  };
  // Encoding order follows the struct declaration: feeTotal sits in the
  // primary-type position (after totalClaimable), then the slashes
  // array-hash, then the feeDistributions array-hash last — matching
  // QuadphaseHashing.sol::hashSettleWitness + HashSettleWitness (Go).
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint8, bytes32, uint256, uint256, bytes32, uint256, uint256, uint256, bytes32",
      ),
      [
        SETTLE_WITNESS_TYPEHASH,
        witness.actionTag,
        witness.merkleRoot,
        witness.totalClaimable,
        witness.feeTotal,
        hashSlashes(witness.slashes),
        witness.leafCount,
        witness.slashEntryOffset,
        witness.totalSlashEntries,
        hashFeeDistributions(witness.feeDistributions),
      ],
    ),
  );
  return { witness, contentHash };
}
