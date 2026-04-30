// settlement-intent.ts — oracle-signed SettlementIntent builder.
//
// An operator script signs + publishes a Merkle-root settlement via
// the oracle private key. The oracle signer is set in RezonForge's
// constructor at deploy time.
//
// EIP-712 typehash (must match RezonForge.SETTLEMENT_INTENT_TYPEHASH):
//   "SettlementIntent(bytes32 questionId,bytes32 merkleRoot,uint256 totalClaimable,address sampleRecipient,uint256 sampleAmount,bytes32 sampleProofHash,uint256 expiresAt,bytes32 slashedCommitsHash,bytes32 slashedVotesHash)"
//
// Note the typehash declares pre-hashed bytes32 fields for the three
// dynamic arrays (sampleProof, slashedCommitHashes, slashedVoteHashes).
// The contract's _hashSettlementIntent computes
// `keccak256(abi.encodePacked(arr))` for each and feeds the resulting
// bytes32 into abi.encode. We mirror that exactly: the builder accepts
// the original arrays, hashes them with keccak256(concat(...)), and
// places the hashes into the EIP-712 message. Any other shape (e.g.
// declaring the typed-data schema with `bytes32[]` fields) would make
// viem compute a different typehash than the contract uses and the
// recovered signer would not match the oracle address on-chain.

import { concat, keccak256 } from "viem";
import type { Address, Hex, TypedDataDomain } from "viem";
import { buildForgeDomain } from "./forge-domain.js";

/** EIP-712 types for SettlementIntent. Field order + types match the
 *  contract's typehash string byte-for-byte; reordering or renaming
 *  any field breaks on-chain signature recovery. */
export const SETTLEMENT_INTENT_TYPES = {
  SettlementIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "merkleRoot", type: "bytes32" },
    { name: "totalClaimable", type: "uint256" },
    { name: "sampleRecipient", type: "address" },
    { name: "sampleAmount", type: "uint256" },
    { name: "sampleProofHash", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "slashedCommitsHash", type: "bytes32" },
    { name: "slashedVotesHash", type: "bytes32" },
  ],
} as const;

/** Default TTL for a settlement envelope. 30 minutes gives the
 *  operator room to sign offline + broadcast; the contract rejects
 *  on expiresAt <= block.timestamp. */
export const DEFAULT_SETTLEMENT_TTL_SECONDS = 30 * 60;

export interface SettlementIntentMessage {
  questionId: Hex;
  merkleRoot: Hex;
  totalClaimable: bigint;
  sampleRecipient: Address;
  sampleAmount: bigint;
  sampleProofHash: Hex;
  expiresAt: bigint;
  slashedCommitsHash: Hex;
  slashedVotesHash: Hex;
}

export interface BuildSettlementIntentInput {
  forgeAddress: Address;
  chainId: number;
  questionId: Hex;
  merkleRoot: Hex;
  /** Total USDC claimable across the whole tree (sum of leaf amounts).
   *  Contract uses this for invariant checks; must equal pool. */
  totalClaimable: bigint;
  /** Any single recipient/amount/proof from the tree, used by the
   *  contract as a sample-proof self-check at settle time. */
  sampleRecipient: Address;
  sampleAmount: bigint;
  sampleProof: readonly Hex[];
  /** Intent hashes of losing commits — stakes slashed into pool at
   *  settlement time. Empty for rounds with no losers. */
  slashedCommitHashes?: readonly Hex[];
  /** Intent hashes of wrong-voter intents — stakes slashed. */
  slashedVoteHashes?: readonly Hex[];
  /** Unix seconds. Defaults to now + 30min. */
  expiresAtSeconds?: number;
  /** Wall-clock seconds (test injection). Defaults to Math.floor(Date.now()/1000). */
  nowSeconds?: number;
}

export interface SettlementTypedData {
  domain: TypedDataDomain;
  types: typeof SETTLEMENT_INTENT_TYPES;
  primaryType: "SettlementIntent";
  message: SettlementIntentMessage;
  /** Raw arrays needed by the broadcaster (publishSettlement takes
   *  the original arrays, not the pre-hashed bytes32 fields). */
  sampleProof: readonly Hex[];
  slashedCommitHashes: readonly Hex[];
  slashedVoteHashes: readonly Hex[];
}

/** keccak256(abi.encodePacked(bytes32[])) — concat of 32-byte elements,
 *  matching Solidity's encodePacked over a bytes32 array. Empty array
 *  hashes to keccak256(""), same as the contract. */
function hashBytes32Array(arr: readonly Hex[]): Hex {
  if (arr.length === 0) return keccak256("0x");
  return keccak256(concat(arr as Hex[]));
}

/** Build the EIP-712 typed data for signTypedData. The oracle signs
 *  this; the contract recovers to `oracle` on publishSettlement. */
export function buildSettlementIntentTypedData(
  input: BuildSettlementIntentInput,
): SettlementTypedData {
  // F14 (mega-audit T2 fence): the contract reverts
  // ForgeZeroMerkleRoot when merkleRoot == 0. Reject here so the
  // oracle never spends gas on a guaranteed-revert publishSettlement.
  if (
    !input.merkleRoot ||
    /^0x0+$/.test(input.merkleRoot)
  ) {
    throw new Error(
      "settlement intent: merkleRoot must be non-zero (chain reverts ForgeZeroMerkleRoot per F14)",
    );
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = BigInt(input.expiresAtSeconds ?? now + DEFAULT_SETTLEMENT_TTL_SECONDS);

  const sampleProof = input.sampleProof;
  const slashedCommitHashes = input.slashedCommitHashes ?? [];
  const slashedVoteHashes = input.slashedVoteHashes ?? [];

  return {
    domain: buildForgeDomain({
      chainId: input.chainId,
      forgeAddress: input.forgeAddress,
    }),
    types: SETTLEMENT_INTENT_TYPES,
    primaryType: "SettlementIntent",
    message: {
      questionId: input.questionId,
      merkleRoot: input.merkleRoot,
      totalClaimable: input.totalClaimable,
      sampleRecipient: input.sampleRecipient,
      sampleAmount: input.sampleAmount,
      sampleProofHash: hashBytes32Array(sampleProof),
      expiresAt,
      slashedCommitsHash: hashBytes32Array(slashedCommitHashes),
      slashedVotesHash: hashBytes32Array(slashedVoteHashes),
    },
    sampleProof,
    slashedCommitHashes,
    slashedVoteHashes,
  };
}
