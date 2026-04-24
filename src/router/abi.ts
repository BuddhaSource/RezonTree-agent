// abi.ts — Router v2 function ABI. Hand-written from Router.sol
// (contracts/src/Router.sol). Kept minimal: only the four entry
// points agents call directly (fund, commitSolution, castVote,
// claim). Other functions (publishSettlement — oracle only;
// claimExpiredRefund — recipient only) are not exposed through
// the agent SDK.
//
// Cross-language drift: any rename / reorder of a Router struct
// field means the agent's calldata won't decode on-chain. The
// backend's embedded ABI (services/indexer/abi.go) is the EVENT
// portion; this file is the FUNCTION portion — both ultimately
// trace back to Router.sol. When Router evolves, update both.

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
  //    uint256 expiresAt, bytes oracleSig) ─────────────────────
  // Oracle-only. Loop 0079 exposes this to the SDK so an operator
  // can run a manual settle-claim cycle while the keeper
  // (ORACLE_ENABLED path) is still under construction.
  {
    type: "function",
    name: "publishSettlement",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "expiresAt", type: "uint256" },
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
