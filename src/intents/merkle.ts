// merkle.ts — canonical Merkle leaf + tree helpers matching
// Router.sol's MerkleProof.verify contract (double-keccak leaf,
// commutative pair-hashing).
//
// Must agree byte-for-byte with internal/signer/merkle.go (Go) and
// contracts/src/Router.sol (Solidity). Pinned test vectors live
// alongside; any drift across the three stacks fails them.
//
// Scope boundary: this file is a pure library — no network calls,
// no signer. Callers compose leaves from domain data and ask for
// the root or a claimant's proof.

import type { Address, Hex } from "viem";
import { concatHex, encodeAbiParameters, keccak256 } from "viem";

/** One recipient's payout row in the settlement tree. */
export interface MerkleLeaf {
  questionId: Hex; // bytes32
  recipient: Address; // 20 bytes, ABI-padded left to 32 in encoding
  amount: bigint; // uint256
}

/** leaf = keccak256(keccak256(abi.encode(qid, recipient, amount)))
 *
 *  Router.sol `_settlementLeaf` uses this double-keccak pattern
 *  (OpenZeppelin second-preimage-attack mitigation). The outer
 *  keccak is critical: without it an internal tree node could
 *  collide with a leaf and let an attacker craft a false proof.
 */
export function hashLeaf(leaf: MerkleLeaf): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { name: "questionId", type: "bytes32" },
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      [leaf.questionId, leaf.recipient, leaf.amount],
    ),
  );
  return keccak256(inner);
}

/** Commutative pair hash: keccak256(sort(a,b)) so proof
 *  verification needn't track left/right orientation. OpenZeppelin
 *  MerkleProof.verify assumes this property. */
function pairHash(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concatHex([lo, hi]));
}

/** Build tree levels bottom-up. Each level is the pairwise hash of
 *  the previous; odd-count levels promote the last leaf unchanged
 *  (matches OZ's convention). Returns [leavesLevel, ..., rootLevel]. */
export function buildTreeLevels(leafHashes: Hex[]): Hex[][] {
  if (leafHashes.length === 0) {
    throw new Error("buildTreeLevels: empty leaf set");
  }
  const levels: Hex[][] = [leafHashes.slice()];
  let cur = leafHashes.slice();
  while (cur.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 < cur.length) {
        next.push(pairHash(cur[i], cur[i + 1]));
      } else {
        // Odd element — promote unchanged. Matches OZ
        // MerkleProof.verify behaviour.
        next.push(cur[i]);
      }
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

/** Compute the Merkle root from a list of leaves. */
export function merkleRoot(leaves: MerkleLeaf[]): Hex {
  const hashes = leaves.map(hashLeaf);
  const levels = buildTreeLevels(hashes);
  return levels[levels.length - 1][0];
}

/** Build the inclusion proof for leafIndex. Empty array for a
 *  single-leaf tree (root == leafHash). */
export function merkleProof(leafHashes: Hex[], leafIndex: number): Hex[] {
  const levels = buildTreeLevels(leafHashes);
  const proof: Hex[] = [];
  let idx = leafIndex;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const layer = levels[lvl];
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (siblingIdx < layer.length) {
      proof.push(layer[siblingIdx]);
    }
    // If siblingIdx is out of range, this element was promoted
    // (odd-count level); no sibling to include.
    idx = Math.floor(idx / 2);
  }
  return proof;
}
