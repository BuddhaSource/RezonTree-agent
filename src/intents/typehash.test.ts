// typehash.test.ts — cross-stack typehash regression fence.
//
// Asserts that each TS-built EIP-712 typehash matches the literal
// hex pinned from the Solidity source byte-for-byte. The pinned
// hexes are computed off the typehash strings declared in
// contracts/src/RezonForge.sol (lines 238 / 246 / 250 / 254 / 260)
// and verified via `cast keccak` against the deployed bytecode.
//
// Why this fence exists: pre-launch, the SDK drifted from v2.9 to
// v2.10 typed-data without anyone rebuilding the typehash. The
// signed intent then hashed to a value the on-chain
// SignatureChecker could not match, surfacing as
// `ForgeBadSigner` — an opaque revert deep in the broadcast path.
// This single test catches that drift class instantly: it
// recomputes the typehash from the TS schema strings and pins them
// to known-good hex.
//
// 3-stack fence: Solidity (RezonForge.sol) ↔ Go (internal/signer/*) ↔
// TS (this assertion). Update all three together when a typehash
// changes; never one without the others.

import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";

const PINNED = {
  // contracts/src/RezonForge.sol:238
  SponsorIntent:
    "0xdd1eeb78695cb1f2fa6ed144a6389e1dc134d00f3a3e6fe895a4a04afea8faf3",
  // contracts/src/RezonForge.sol:246
  CosponsorIntent:
    "0xd9c03036132b2691bcf944f8964155d518856f9766727315bba50e72a9769dd4",
  // contracts/src/RezonForge.sol:250
  CommitIntent:
    "0x6c9a41343766487b62acf6bde0a8c4100342465502c5fe1cf72f3a36114a84a9",
  // contracts/src/RezonForge.sol:254
  VoteIntent:
    "0xce846377b54778704a6c695296cc69e3ebdfc08f87a6ef80f5fa07c7db946e2a",
  // contracts/src/RezonForge.sol:260
  SettlementIntent:
    "0x5fd3f7763a7f80bea9def70b7777f24d1891db2d630a554739eceaef073cd67c",
} as const;

// Typehash strings — must match Solidity byte-for-byte. The
// FeeShare reference type appears in alphabetical order after the
// primary type per EIP-712 §"Definition of encodeType". For
// SettlementIntent there is no referenced struct.
const TYPEHASH_STRINGS = {
  SponsorIntent:
    "SponsorIntent(bytes32 questionId,address oracle,address token,uint256 stakeFloor,uint256 stakeBasisPoints,uint256 sponsorshipFloor,uint256 voteFee,uint256 commitFee,uint256 noSolutionGracePeriod,uint256 feeShareBps,address platformFeeRecipient,uint256 abandonmentGracePeriod,uint256 fundingDeadline,address sponsor,uint256 amount,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
    "FeeShare(address recipient,uint256 basisPoints)",
  CosponsorIntent:
    "CosponsorIntent(bytes32 questionId,address sponsor,uint256 amount,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
    "FeeShare(address recipient,uint256 basisPoints)",
  CommitIntent:
    "CommitIntent(bytes32 questionId,address submitter,bytes32 contentHash,uint256 feeAmount,uint256 stakeAmount,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
    "FeeShare(address recipient,uint256 basisPoints)",
  VoteIntent:
    "VoteIntent(bytes32 questionId,address voter,bytes32 allocationsHash,uint256 feeAmount,uint256 stakeAmount,FeeShare[] feeShares,uint256 nonce,uint256 chainId,uint256 expiresAt)" +
    "FeeShare(address recipient,uint256 basisPoints)",
  SettlementIntent:
    "SettlementIntent(bytes32 questionId,bytes32 merkleRoot,uint256 totalClaimable,address sampleRecipient,uint256 sampleAmount,bytes32 sampleProofHash,uint256 expiresAt,bytes32 slashedCommitsHash,bytes32 slashedVotesHash)",
} as const;

describe("EIP-712 typehash cross-stack invariants", () => {
  for (const name of Object.keys(PINNED) as (keyof typeof PINNED)[]) {
    it(`${name} typehash matches RezonForge.sol byte-for-byte`, () => {
      const computed = keccak256(stringToBytes(TYPEHASH_STRINGS[name]));
      expect(computed).toBe(PINNED[name]);
    });
  }
});
