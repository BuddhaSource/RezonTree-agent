// quadphase-broadcast.ts — BountyForge chain entry points.
//
// Wraps viem's writeContract for the three universal envelope entry
// points that replaced the legacy per-action functions
// (sponsor/cosponsor/commitSolution/castVote/claim/publishSettlement):
//
//   submit(env, sig)                        — Cosponsor, Commit, Vote, Abandon
//   sponsorSubmit(env, sig, witnessBytes)   — Sponsor (carries the
//                                             witness so the chain can
//                                             decode oracle + grace)
//   pullValue(env, sig, witnessBytes)       — Claim, Refund
//
// The witness bytes for sponsorSubmit and pullValue are the abi-
// encoded witness struct (NOT the typehash-prefixed hashStruct
// preimage) — the contract decodes them with `abi.decode(bytes,
// (SponsorWitness))` etc. and recomputes the contentHash itself.
//
// R-CHAIN-VERIFIES-INTENT: chain re-derives env.contentHash from the
// supplied witness bytes; a mismatch reverts before any state write.
// R-CLIENT-IS-TRUST-ORIGIN: the envelope + signature pair were built
// from preflight-advertised params; the backend never relays.

import {
  type Account,
  type Address,
  type Hex,
  type WalletClient,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";

import type { Envelope, FeeShare, Funds } from "../intents/envelope.js";
import type { SponsorWitness } from "../intents/sponsor-witness.js";
import type { ClaimWitness } from "../intents/claim-witness.js";
import type { RefundWitness } from "../intents/refund-witness.js";

// ─── Minimal ABI fragments for the three entry points ────────────────
//
// Kept as a self-contained fragment here so the legacy REZON_FORGE_ABI
// (still referenced by src/forge/client.ts for backward-compatible
// helpers) doesn't need a coordinated rewrite. The fragments below are
// the only chain surface the post-cutover SDK actually broadcasts to.

const FEE_SHARE_TUPLE = {
  type: "tuple",
  name: "feeShare",
  components: [
    { name: "recipient", type: "address" },
    { name: "basisPoints", type: "uint16" },
  ],
} as const;

const FUNDS_TUPLE = {
  type: "tuple",
  name: "funds",
  components: [
    { name: "token", type: "address" },
    { name: "poolIn", type: "uint256" },
    { name: "poolOut", type: "uint256" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeShareBps", type: "uint16" },
    {
      type: "tuple[]",
      name: "feeShares",
      components: [
        { name: "recipient", type: "address" },
        { name: "basisPoints", type: "uint16" },
      ],
    },
    { name: "stakeAmount", type: "uint256" },
    { name: "stakeOp", type: "uint8" },
  ],
} as const;

const ENVELOPE_TUPLE = {
  type: "tuple",
  name: "env",
  components: [
    { name: "signer", type: "address" },
    { name: "qid", type: "bytes32" },
    { name: "action", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "contentHash", type: "bytes32" },
    FUNDS_TUPLE,
  ],
} as const;

export const QUADPHASE_ENTRY_ABI = [
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [ENVELOPE_TUPLE, { name: "sig", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function",
    name: "sponsorSubmit",
    stateMutability: "nonpayable",
    inputs: [
      ENVELOPE_TUPLE,
      { name: "sig", type: "bytes" },
      { name: "witnessBytes", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pullValue",
    stateMutability: "nonpayable",
    inputs: [
      ENVELOPE_TUPLE,
      { name: "sig", type: "bytes" },
      { name: "witnessBytes", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// ─── Envelope marshalling ────────────────────────────────────────────
//
// viem writeContract takes the envelope as a positional tuple; we
// build it once from the typed Envelope object the signer side uses.

function envelopeAsTuple(env: Envelope) {
  return {
    signer: env.signer,
    qid: env.qid,
    action: env.action as number,
    nonce: env.nonce,
    expiresAt: env.expiresAt,
    contentHash: env.contentHash,
    funds: fundsAsTuple(env.funds),
  };
}

function fundsAsTuple(f: Funds) {
  return {
    token: f.token,
    poolIn: f.poolIn,
    poolOut: f.poolOut,
    feeAmount: f.feeAmount,
    feeShareBps: f.feeShareBps,
    feeShares: f.feeShares.map((s: FeeShare) => ({
      recipient: s.recipient,
      basisPoints: s.basisPoints,
    })),
    stakeAmount: f.stakeAmount,
    stakeOp: f.stakeOp as number,
  };
}

// ─── Witness byte encoders ───────────────────────────────────────────
//
// The chain decodes via `abi.decode(witnessBytes, (Witness))`. The Go
// reconciler does the inverse during Stage-4 hash recomputation; both
// sides must use the bare struct-as-tuple ABI encoding (no typehash
// prefix here — the typehash is folded inside contentHash, not the
// raw witness bytes).

/** Encode a SponsorWitness for `sponsorSubmit(witnessBytes)`. */
export function encodeSponsorWitnessBytes(w: SponsorWitness): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "(uint8 actionTag, string title, string body, string criteria, string[] tags, address oracle, uint256 sponsorshipFloor, uint256 commitFee, uint256 voteFee, uint256 stakeFloor, uint16 stakeBasisPoints, uint256 fundingDeadline, uint256 noSolutionGracePeriod)",
    ),
    [
      {
        actionTag: w.actionTag,
        title: w.title,
        body: w.body,
        criteria: w.criteria,
        tags: w.tags,
        oracle: w.oracle,
        sponsorshipFloor: w.sponsorshipFloor,
        commitFee: w.commitFee,
        voteFee: w.voteFee,
        stakeFloor: w.stakeFloor,
        stakeBasisPoints: w.stakeBasisPoints,
        fundingDeadline: w.fundingDeadline,
        noSolutionGracePeriod: w.noSolutionGracePeriod,
      },
    ],
  );
}

/** Encode a ClaimWitness for `pullValue(witnessBytes)`. */
export function encodeClaimWitnessBytes(w: ClaimWitness): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "(uint8 actionTag, bytes32[] proof, uint256 leafIndex, uint256 leafAmount, uint8 role, uint8 expectedStatus)",
    ),
    [
      {
        actionTag: w.actionTag,
        proof: w.proof,
        leafIndex: w.leafIndex,
        leafAmount: w.leafAmount,
        role: w.role,
        expectedStatus: w.expectedStatus,
      },
    ],
  );
}

/** Encode a RefundWitness for `pullValue(witnessBytes)`. */
export function encodeRefundWitnessBytes(w: RefundWitness): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "(uint8 actionTag, bytes32 sourceIntentHash, uint256 expectedAmount, uint8 expectedStatus)",
    ),
    [
      {
        actionTag: w.actionTag,
        sourceIntentHash: w.sourceIntentHash,
        expectedAmount: w.expectedAmount,
        expectedStatus: w.expectedStatus,
      },
    ],
  );
}

// ─── Broadcast helpers ───────────────────────────────────────────────

export interface BroadcastSubmitParams {
  forgeAddress: Address;
  envelope: Envelope;
  signature: Hex;
  /** Optional gas override. Public Base Sepolia's eth_estimateGas
   *  occasionally returns ~10% under actual; pass 400_000n for safety. */
  gas?: bigint;
}

/**
 * Broadcasts the universal `submit(env, sig)` entry point. Use for
 * Cosponsor / Commit / Vote / Abandon actions.
 */
export async function broadcastSubmit(
  wallet: WalletClient,
  params: BroadcastSubmitParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: QUADPHASE_ENTRY_ABI,
    functionName: "submit",
    args: [envelopeAsTuple(params.envelope), params.signature],
    account: wallet.account as Account,
    chain: wallet.chain,
    ...(params.gas ? { gas: params.gas } : {}),
  });
}

export interface BroadcastSponsorSubmitParams {
  forgeAddress: Address;
  envelope: Envelope;
  signature: Hex;
  witness: SponsorWitness;
  gas?: bigint;
}

/**
 * Broadcasts `sponsorSubmit(env, sig, witnessBytes)`. The chain
 * decodes the witness to extract `oracle`, `fundingDeadline`, and
 * `noSolutionGracePeriod` (data not in the envelope), then writes
 * the QuestionState's oracle + recoverableAt.
 */
export async function broadcastSponsorSubmit(
  wallet: WalletClient,
  params: BroadcastSponsorSubmitParams,
): Promise<Hex> {
  const witnessBytes = encodeSponsorWitnessBytes(params.witness);
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: QUADPHASE_ENTRY_ABI,
    functionName: "sponsorSubmit",
    args: [envelopeAsTuple(params.envelope), params.signature, witnessBytes],
    account: wallet.account as Account,
    chain: wallet.chain,
    ...(params.gas ? { gas: params.gas } : {}),
  });
}

export interface BroadcastPullValueParams {
  forgeAddress: Address;
  envelope: Envelope;
  signature: Hex;
  /** Pre-encoded witness bytes (use encodeClaimWitnessBytes or
   *  encodeRefundWitnessBytes). */
  witnessBytes: Hex;
  gas?: bigint;
}

/**
 * Broadcasts `pullValue(env, sig, witnessBytes)`. Use for Claim and
 * Refund actions; the contract dispatches on `env.action`.
 */
export async function broadcastPullValue(
  wallet: WalletClient,
  params: BroadcastPullValueParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: QUADPHASE_ENTRY_ABI,
    functionName: "pullValue",
    args: [
      envelopeAsTuple(params.envelope),
      params.signature,
      params.witnessBytes,
    ],
    account: wallet.account as Account,
    chain: wallet.chain,
    ...(params.gas ? { gas: params.gas } : {}),
  });
}
