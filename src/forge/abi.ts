// abi.ts — Router function ABI. Hand-written from Router.sol.
// Includes the entry points agents call (fund, commitSolution,
// castVote, claim, claim{Solution,Vote}Bond), oracle-only
// publishSettlement + sweepResiduals, and view getters used by
// health checks and tests.
//
// Cross-language drift risk: any rename or reorder of a Router
// struct field silently breaks agent calldata. The backend's
// embedded ABI (services/indexer/abi.go) covers the EVENT side;
// this file covers the FUNCTION side. Both must be updated when
// Router.sol changes.

import type { Abi } from "viem";

export const ROUTER_V2_ABI = [
  // ── Structs (anonymous tuples per viem convention) ────────────

  // ── fund(FundIntent intent, bytes intentSig, uint8 permitV,
  //    bytes32 permitR, bytes32 permitS) ──────────────────────
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "funder", type: "address" },
          { name: "amount", type: "uint256" },
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
  // match Router.sol's QuestionState in declaration order.
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

  // ── sweepResiduals(address to, uint256 amount) ─────────────
  // Admin-only drain of USDC that isn't claimable via any
  // intent-owner path (dust, accidental transfers).
  {
    type: "function",
    name: "sweepResiduals",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },

  // ── Read-only sanity (used by health checks / tests) ──────
  {
    type: "function",
    name: "oracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "minBond",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;

/** Names agents call. Exported for tooling (e.g. cast-send
 *  templates). */
export const ROUTER_WRITE_FUNCTIONS = [
  "fund",
  "commitSolution",
  "castVote",
  "claim",
] as const;

export type RouterWriteFunction = (typeof ROUTER_WRITE_FUNCTIONS)[number];
