// abi.ts — RezonForge function ABI. Hand-written from
// contracts/src/RezonForge.sol; the abi.test.ts pin enforces field
// order against drift.
//
// Includes the entry points agents call (sponsor, cosponsor,
// commitSolution, castVote, claim, claim{Solution,Vote}Stake),
// oracle-only publishSettlement + sweepResiduals, and view getters
// used by health checks and tests.
//
// Cross-language drift risk: any rename or reorder of a struct
// field silently breaks agent calldata. The backend's embedded ABI
// (services/indexer/abi.go) covers the EVENT side; this file
// covers the FUNCTION side. Both must be updated when
// RezonForge.sol changes.

import type { Abi } from "viem";

export const REZON_FORGE_ABI = [
  // ── sponsor(SponsorIntent intent, bytes intentSig, uint8 permitV,
  //    bytes32 permitR, bytes32 permitS) ─────────────────────────
  // First sponsor binds all per-Q parameters: oracle, token, floors,
  // voteFee, commitFee, noSolutionGracePeriod, feeShareBps,
  // platformFeeRecipient, abandonmentGracePeriod, fundingDeadline,
  // and the sponsor's feeShares allocation.
  {
    type: "function",
    name: "sponsor",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "oracle", type: "address" },
          { name: "token", type: "address" },
          { name: "stakeFloor", type: "uint256" },
          { name: "stakeBasisPoints", type: "uint256" },
          { name: "sponsorshipFloor", type: "uint256" },
          { name: "voteFee", type: "uint256" },
          { name: "commitFee", type: "uint256" },
          { name: "noSolutionGracePeriod", type: "uint256" },
          // Q-level feeShareBps — frozen at sponsor() for the question's
          // lifetime. Applied to every contribution. Must be ≤ 5000 (50%).
          { name: "feeShareBps", type: "uint256" },
          { name: "platformFeeRecipient", type: "address" },
          { name: "abandonmentGracePeriod", type: "uint256" },
          // Sponsor-signed funding-window deadline. Must be >
          // block.timestamp at sponsor() AND >= expiresAt; cosponsor /
          // commit / vote revert ForgeFundingDeadlinePassed past it.
          { name: "fundingDeadline", type: "uint256" },
          { name: "sponsor", type: "address" },
          { name: "amount", type: "uint256" },
          {
            name: "feeShares",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "basisPoints", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      { name: "intentSig", type: "bytes" },
      { name: "permitV", type: "uint8" },
      { name: "permitR", type: "bytes32" },
      { name: "permitS", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── cosponsor(CosponsorIntent intent, ...) ─────────────────────
  // Subsequent contributors to an OPEN question inherit per-Q params
  // (oracle, token, floors, fees, grace, feeShareBps) from chain state.
  {
    type: "function",
    name: "cosponsor",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "sponsor", type: "address" },
          { name: "amount", type: "uint256" },
          {
            name: "feeShares",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "basisPoints", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      { name: "intentSig", type: "bytes" },
      { name: "permitV", type: "uint8" },
      { name: "permitR", type: "bytes32" },
      { name: "permitS", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── commitSolution(CommitIntent, bytes intentSig, permit V/R/S) ──
  // Submitter signs over `contentHash` (keccak256 of canonical body).
  {
    type: "function",
    name: "commitSolution",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "submitter", type: "address" },
          { name: "contentHash", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "stakeAmount", type: "uint256" },
          {
            name: "feeShares",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "basisPoints", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      { name: "intentSig", type: "bytes" },
      { name: "permitV", type: "uint8" },
      { name: "permitR", type: "bytes32" },
      { name: "permitS", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── castVote(VoteIntent, bytes intentSig, permit V/R/S) ────
  // Voter signs over `allocationsHash` — keccak256(canonical
  // allocations || serverSalt). Salt comes from vote-preflight.
  {
    type: "function",
    name: "castVote",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "voter", type: "address" },
          { name: "allocationsHash", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "stakeAmount", type: "uint256" },
          {
            name: "feeShares",
            type: "tuple[]",
            components: [
              { name: "recipient", type: "address" },
              { name: "basisPoints", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      { name: "intentSig", type: "bytes" },
      { name: "permitV", type: "uint8" },
      { name: "permitR", type: "bytes32" },
      { name: "permitS", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── claim(bytes32 qid, address recipient, uint256 amount, bytes32[] proof) ────
  // EXECUTOR-CALLABLE: msg.sender pays gas, recipient receives funds.
  // Recipient is bound by the merkle leaf at settlement time, so the
  // call reverts if you pass a recipient the oracle did not author.
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },

  // ── claimAllForQuestion(qid, recipient, poolAmount, poolProof, solHash, voteHash) ──
  // EXECUTOR-CALLABLE: pool funds → recipient (merkle-bound);
  // stake funds → chain-recorded solutionStakeOwner / voteStakeOwner.
  {
    type: "function",
    name: "claimAllForQuestion",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "poolAmount", type: "uint256" },
      { name: "poolProof", type: "bytes32[]" },
      { name: "solutionIntentHash", type: "bytes32" },
      { name: "voteIntentHash", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── claimPendingShares(address recipient, address token, uint256 amount) ──
  // EXECUTOR-CALLABLE: pulls from pendingShares[recipient][token]
  // and transfers to `recipient`. Anyone can call (msg.sender pays gas).
  {
    type: "function",
    name: "claimPendingShares",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },

  // ── publishSettlement(SettlementIntent intent, bytes oracleSig) ──
  // Oracle-only. Exposed to the SDK so an operator can run a
  // manual settle-claim cycle. Field order mirrors RezonForge.sol's
  // SettlementIntent struct exactly.
  {
    type: "function",
    name: "publishSettlement",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "merkleRoot", type: "bytes32" },
          { name: "totalClaimable", type: "uint256" },
          { name: "sampleRecipient", type: "address" },
          { name: "sampleAmount", type: "uint256" },
          { name: "sampleProof", type: "bytes32[]" },
          { name: "expiresAt", type: "uint256" },
          { name: "slashedCommitHashes", type: "bytes32[]" },
          { name: "slashedVoteHashes", type: "bytes32[]" },
        ],
      },
      { name: "oracleSig", type: "bytes" },
    ],
    outputs: [],
  },

  // ── questions(bytes32) view returns (QuestionState) ─────────
  // Used to read poolAmount before publishing settlement. Fields
  // match RezonForge.sol's QuestionState in declaration order. The
  // public mapping getter returns all 14 fields as a flat tuple, so
  // every field must be enumerated in source-order or the
  // calldata/return decoding misaligns and viem coerces a misread
  // uint256 chunk into Number — out-of-safe-range crash.
  {
    type: "function",
    name: "questions",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "token", type: "address" },
      { name: "oracle", type: "address" },
      { name: "sponsor", type: "address" },
      { name: "stakeFloor", type: "uint256" },
      { name: "stakeBasisPoints", type: "uint256" },
      { name: "sponsorshipFloor", type: "uint256" },
      { name: "voteFee", type: "uint256" },
      { name: "commitFee", type: "uint256" },
      { name: "noSolutionGracePeriod", type: "uint256" },
      { name: "feeShareBps", type: "uint256" },
      { name: "platformFeeRecipient", type: "address" },
      { name: "abandonmentGracePeriod", type: "uint256" },
      { name: "solutionCount", type: "uint32" },
      { name: "totalSponsorship", type: "uint256" },
      { name: "poolAmount", type: "uint256" },
      { name: "fundingDeadline", type: "uint256" },
      { name: "totalClaimable", type: "uint256" },
    ],
  },

  // ── claimSolutionStake(bytes32 qid, bytes32 intentHash) ────
  // Release a commit stake to its original submitter once the
  // question is SETTLED.
  {
    type: "function",
    name: "claimSolutionStake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "intentHash", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── claimVoteStake(bytes32 qid, bytes32 intentHash) ─────────
  // Release a vote stake to its original voter once the question
  // is SETTLED.
  {
    type: "function",
    name: "claimVoteStake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "intentHash", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── sweepResiduals(address token, address to, uint256 amount) ──
  // Per-token admin-only drain of dust that isn't claimable via
  // any intent-owner path.
  {
    type: "function",
    name: "sweepResiduals",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },

  // ── Read-only sanity (used by health checks / tests) ──────
  {
    type: "function",
    name: "admin",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

/** Names agents call. Exported for tooling (e.g. cast-send
 *  templates). */
export const FORGE_WRITE_FUNCTIONS = [
  "sponsor",
  "cosponsor",
  "commitSolution",
  "castVote",
  "claim",
] as const;

export type ForgeWriteFunction = (typeof FORGE_WRITE_FUNCTIONS)[number];
