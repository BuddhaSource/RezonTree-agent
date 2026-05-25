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
  type PublicClient,
  type WalletClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Envelope, FeeShare, Funds } from "../intents/envelope.js";
import type { SponsorWitness } from "../intents/sponsor-witness.js";
import type { ClaimWitness } from "../intents/claim-witness.js";
import type { RefundWitness } from "../intents/refund-witness.js";
import type { SettleWitness, SlashEntry } from "../intents/settle-witness.js";

// ─── ABI fragments for the v2 envelope entry points ──────────────────
//
// Self-contained fragments for the four universal write entry points
// (submit / sponsorSubmit / pullValue / publishSettlement). The v1
// per-action ABI (REZON_FORGE_ABI in the deleted src/forge/abi.ts) was
// removed in the unified-envelope cutover (#595); these fragments are
// the only chain surface the SDK broadcasts to.

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
  {
    // Settle — oracle-signed envelope (action=Settle) carrying the
    // SettleWitness (merkleRoot + slashes + offsets) as witnessBytes.
    // Same (env, sig, witnessBytes) ABI as pullValue/sponsorSubmit; the
    // contract decodes the witness, recomputes hashSettleWitness, and
    // rejects a contentHash mismatch before any state write.
    type: "function",
    name: "publishSettlement",
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

/** Encode a SettleWitness for `publishSettlement(witnessBytes)`. The
 *  contract decodes via `abi.decode(witnessBytes, (SettleWitness))`,
 *  where SettleWitness embeds a `SlashEntry[]` tuple array. Field
 *  order matches QuadphaseTypes.SettleWitness / settle-witness.ts's
 *  SETTLE_WITNESS_TYPES byte-for-byte. */
export function encodeSettleWitnessBytes(w: SettleWitness): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "(uint8 actionTag, bytes32 merkleRoot, uint256 totalClaimable, uint256 dustFolded, (bytes32 intentHash, uint256 amount, uint8 role)[] slashes, uint256 leafCount, uint256 slashEntryOffset, uint256 totalSlashEntries)",
    ),
    [
      {
        actionTag: w.actionTag,
        merkleRoot: w.merkleRoot,
        totalClaimable: w.totalClaimable,
        dustFolded: w.dustFolded,
        slashes: w.slashes.map((s: SlashEntry) => ({
          intentHash: s.intentHash,
          amount: s.amount,
          role: s.role,
        })),
        leafCount: w.leafCount,
        slashEntryOffset: w.slashEntryOffset,
        totalSlashEntries: w.totalSlashEntries,
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
 *
 * VOTE-PRIVACY INVARIANT — DO NOT ADD THE WITNESS TO THIS CALLDATA.
 * For a Vote, the witness holds the raw allocations (which solution got how
 * many points). The chain must NEVER see them: `submit` is called with ONLY
 * `(envelope, signature)`. The envelope carries an opaque `contentHash =
 * HashVoteWitness(actionTag, allocations, salt)` where `salt` is a unique
 * 32-byte server-issued value per voter (signer/vote_salt.go). Because each
 * voter's salt differs, two voters who allocate IDENTICALLY still produce
 * different contentHashes — so on-chain their votes are unlinkable and the
 * allocations are not rainbow-table-enumerable from the public Quadphase
 * event. The raw witness is POSTed to the backend only (off-chain), for
 * settle-time tallying. If you ever add `witnessBytes` here for Vote, you
 * publish every voter's choices on-chain — privacy is gone. (Claim/Refund
 * use the separate pullValue path, where the witness is non-secret.)
 */
export async function broadcastSubmit(
  wallet: WalletClient,
  params: BroadcastSubmitParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: QUADPHASE_ENTRY_ABI,
    functionName: "submit",
    // (envelope, signature) ONLY — never the witness (see invariant above).
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

export interface BroadcastSettleParams {
  forgeAddress: Address;
  envelope: Envelope;
  signature: Hex;
  /** The oracle's SettleWitness — abi-encoded to witnessBytes here. */
  witness: SettleWitness;
  gas?: bigint;
}

/**
 * Broadcasts `publishSettlement(env, sig, witnessBytes)`. The signer is
 * the question's oracle; the contract decodes the SettleWitness,
 * recomputes hashSettleWitness, asserts it == env.contentHash, then
 * flips Open → Settling (first chunk) or Settling → Settled (final
 * chunk) and moves slashed stakes into the pool atomically with the
 * merkle-root commit.
 */
export async function broadcastSettle(
  wallet: WalletClient,
  params: BroadcastSettleParams,
): Promise<Hex> {
  const witnessBytes = encodeSettleWitnessBytes(params.witness);
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: QUADPHASE_ENTRY_ABI,
    functionName: "publishSettlement",
    args: [envelopeAsTuple(params.envelope), params.signature, witnessBytes],
    account: wallet.account as Account,
    chain: wallet.chain,
    ...(params.gas ? { gas: params.gas } : {}),
  });
}

// ─── Wallet + receipt helpers (relocated from the deleted v1 client.ts) ─
//
// These two are chain-plumbing primitives the live MCP server + the
// operator scripts depend on. They were defined in src/forge/client.ts
// alongside the v1 broadcasters; when that file was deleted in the v2
// cutover (#595) they moved here so the only surviving import surface is
// the v2 broadcast module.

/**
 * Constructs a WalletClient for an agent from a raw private key. Uses
 * viem's `privateKeyToAccount` so the 0x-prefixed hex from the agent's
 * HD derivation (src/wallet/derive.ts) is accepted directly.
 */
export function makeAgentWalletClient(params: {
  privateKey: Hex;
  chainId: number;
  rpcUrl: string;
}): WalletClient {
  const account = privateKeyToAccount(params.privateKey);
  return createWalletClient({
    account,
    chain: {
      id: params.chainId,
      name: `chain-${params.chainId}`,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [params.rpcUrl] } },
    },
    transport: http(params.rpcUrl),
  });
}

/**
 * Awaits the transaction receipt + asserts `status === "success"`.
 * Throws on revert with the tx hash so the caller can explore the
 * failure on the block explorer.
 */
export async function awaitReceipt(
  client: PublicClient,
  hash: Hex,
): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(
      `RezonForge call reverted: tx ${hash}; check block explorer for revert reason.`,
    );
  }
}
