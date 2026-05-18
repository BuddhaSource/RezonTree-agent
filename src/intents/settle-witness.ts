// settle-witness.ts — Quadphase v2 SettleWitness builder.
//
// Oracle's settlement publication payload. Supports chunked publishing
// via slashEntryOffset / totalSlashEntries; the final chunk carries the
// merkleRoot + totalClaimable that enables claims.
//
// `SlashEntry` is a sub-type; alphabetical sub-type ordering applies.
//
// Drift fenced by polyglot_drift_test (arity=8).

import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export const SETTLE_WITNESS_TYPES = {
  SettleWitness: [
    { name: "actionTag", type: "uint8" },
    { name: "merkleRoot", type: "bytes32" },
    { name: "totalClaimable", type: "uint256" },
    { name: "dustFolded", type: "uint256" },
    { name: "slashes", type: "SlashEntry[]" },
    { name: "leafCount", type: "uint256" },
    { name: "slashEntryOffset", type: "uint256" },
    { name: "totalSlashEntries", type: "uint256" },
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

export interface SettleWitness {
  actionTag: number;
  merkleRoot: Hex;
  totalClaimable: bigint;
  dustFolded: bigint;
  slashes: SlashEntry[];
  leafCount: bigint;
  slashEntryOffset: bigint;
  totalSlashEntries: bigint;
}

const SETTLE_WITNESS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "SettleWitness(uint8 actionTag,bytes32 merkleRoot,uint256 totalClaimable,uint256 dustFolded,SlashEntry[] slashes,uint256 leafCount,uint256 slashEntryOffset,uint256 totalSlashEntries)SlashEntry(bytes32 intentHash,uint256 amount,uint8 role)",
  ),
);

const SLASH_ENTRY_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "SlashEntry(bytes32 intentHash,uint256 amount,uint8 role)",
  ),
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

export function buildSettleWitness(w: Omit<SettleWitness, "actionTag">): {
  witness: SettleWitness;
  contentHash: Hex;
} {
  const witness: SettleWitness = {
    actionTag: 4, // ActionTag.Settle
    ...w,
  };
  const contentHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint8, bytes32, uint256, uint256, bytes32, uint256, uint256, uint256",
      ),
      [
        SETTLE_WITNESS_TYPEHASH,
        witness.actionTag,
        witness.merkleRoot,
        witness.totalClaimable,
        witness.dustFolded,
        hashSlashes(witness.slashes),
        witness.leafCount,
        witness.slashEntryOffset,
        witness.totalSlashEntries,
      ],
    ),
  );
  return { witness, contentHash };
}
