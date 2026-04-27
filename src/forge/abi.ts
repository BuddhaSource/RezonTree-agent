// abi.ts — RezonForge v2.5 function ABI. Hand-written from
// contracts/src/RezonForge.sol.
//
// Includes the entry points agents call (sponsor, cosponsor,
// commitSolution, castVote, claim, claim{Solution,Vote}Bond),
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
  // RezonForge v2.5: first sponsor binds all per-Q parameters.
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
          { name: "minBondFloor", type: "uint256" },
          { name: "bondBasisPoints", type: "uint256" },
          { name: "minSponsorship", type: "uint256" },
          { name: "voteFee", type: "uint256" },
          { name: "abandonmentGracePeriod", type: "uint256" },
          { name: "sponsor", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "feeShareBps", type: "uint256" },
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
  // RezonForge v2.5: subsequent contributors inherit per-Q params
  // from chain state.
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
          { name: "feeShareBps", type: "uint256" },
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
  // v2.5: 10-field intent with feeShareBps + feeShares.
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
          { name: "bondAmount", type: "uint256" },
          { name: "feeShareBps", type: "uint256" },
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
  // v2.5: 10-field intent with feeShareBps + feeShares.
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
          { name: "bondAmount", type: "uint256" },
          { name: "feeShareBps", type: "uint256" },
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

  // ── claim(bytes32 qid, uint256 amount, bytes32[] proof) ────
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },

  // ── publishSettlement(bytes32 qid, bytes32 merkleRoot,
  //    uint256 expiresAt, bytes32[] slashedCommitHashes,
  //    bytes32[] slashedVoteHashes, bytes oracleSig) ──────────
  // Oracle-only. Exposed to the SDK so an operator can run a
  // manual settle-claim cycle.
  {
    type: "function",
    name: "publishSettlement",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "expiresAt", type: "uint256" },
      { name: "slashedCommitHashes", type: "bytes32[]" },
      { name: "slashedVoteHashes", type: "bytes32[]" },
      { name: "oracleSig", type: "bytes" },
    ],
    outputs: [],
  },

  // ── questions(bytes32) view returns (QuestionState) ─────────
  // Used to read poolAmount before publishing settlement. Fields
  // match RezonForge.sol's QuestionState in declaration order.
  {
    type: "function",
    name: "questions",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "tokenAddr", type: "address" },
      { name: "solutionCount", type: "uint32" },
      { name: "poolAmount", type: "uint256" },
      { name: "fundingDeadline", type: "uint256" },
    ],
  },

  // ── claimSolutionBond(bytes32 qid, bytes32 intentHash) ────
  // Release a commit bond to its original submitter once the
  // question is SETTLED.
  {
    type: "function",
    name: "claimSolutionBond",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "intentHash", type: "bytes32" },
    ],
    outputs: [],
  },

  // ── claimVoteBond(bytes32 qid, bytes32 intentHash) ─────────
  // Release a vote bond to its original voter once the question
  // is SETTLED.
  {
    type: "function",
    name: "claimVoteBond",
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
