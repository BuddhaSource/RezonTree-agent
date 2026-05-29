// quadphase-flow.ts — end-to-end Quadphase v2 submit flow helpers.
//
// One helper per action that wraps:
//
//   1. Build witness (per-action shape) + contentHash.
//   2. Build envelope (signer + qid + action + nonce + expiresAt +
//      contentHash + funds) from preflight-advertised params.
//   3. EIP-712 sign the envelope via the agent's wallet.
//   4. POST /v1/questions/:id/intents (backend stages the row via the
//      Round-3 unified-intent dispatcher).
//   5. Broadcast to the chain via the universal `submit` /
//      `sponsorSubmit` entry point.
//
// USDC permit handling: the BountyForge contract uses
// `safeTransferFrom(signer, address(this), inflow)` — there is no
// inline EIP-2612 permit anymore. Callers MUST ensure the signer has
// pre-approved the forge address for the required `poolIn + feeAmount
// + stakeAmount`. Use ensureUsdcAllowance() once per agent per token.
//
// R-CLIENT-IS-TRUST-ORIGIN: preflight returns the canonical envelope
// template; this helper builds from it.
// R-INTENT-HASH-IS-MATCH-KEY: backend recomputes intentHash at Stage 2;
// chain emits it at Stage 3; reconciler matches on Stage 4.

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ActionTag,
  StakeOp,
  type Envelope,
  type FeeShare,
  type Funds,
  buildEnvelopeForSigning,
  hashEnvelopeStruct,
} from "../intents/envelope.js";
import { buildSponsorWitness } from "../intents/sponsor-witness.js";
import { buildCosponsorWitness } from "../intents/cosponsor-witness.js";
import {
  buildCommitWitness,
  type CommitWitness,
} from "../intents/commit-witness.js";
import {
  buildVoteWitness,
  type Allocation,
  type VoteWitness,
} from "../intents/vote-witness.js";
import {
  buildAbandonWitness,
  type AbandonWitness,
} from "../intents/abandon-witness.js";
import {
  buildRefundWitness,
  type RefundWitness,
} from "../intents/refund-witness.js";
import {
  buildSettleWitness,
  type FeeDistribution,
  type SettleWitness,
  type SlashEntry,
} from "../intents/settle-witness.js";
import {
  broadcastAbandonSubmit,
  broadcastClaim,
  broadcastSettle,
  broadcastSponsorSubmit,
  broadcastSubmit,
  broadcastPullValue,
  encodeRefundWitnessBytes,
} from "./quadphase-broadcast.js";
import { redactBearer } from "../utils/redact.js";

// BYTES32_RE validates `0x` + 64 lowercase or uppercase hex chars.
// Used by runRefundFlow to guard `sourceIntentHash` against malformed
// input that would silently produce wrong stakeOp selection or chain
// reverts with opaque errors. Audit H2.
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

// ZERO_BYTES32 is the canonical sentinel for "sponsor refund" mode
// (vs stake refund where sourceIntentHash points at the
// commit/vote intent). Compared as a constant so callers can't
// accidentally pass a non-canonical zero hash like "0x00".
const ZERO_BYTES32 = "0x" + "0".repeat(64);

// ─── Intent-hash drift fence ────────────────────────────────────────
//
// R-INTENT-HASH-IS-MATCH-KEY: the client MUST locally recompute the
// EIP-712 intent hash from the constructed envelope and assert it
// matches the preflight-asserted `expectedIntentHash` BEFORE signing.
// Mismatch is fatal — a signature past a drifted hash will reconcile
// onto a row the backend can't match, burning gas and leaving the
// chain ahead of the DB. Both sides recompute from the same EIP-712
// shape; any divergence indicates the client built a different
// envelope (wrong nonce, wrong amounts, stale feeShares, etc.).
//
// Called from every runXxxFlow that takes an `expectedIntentHash`
// from preflight. Flows that don't have a preflight (abandon today,
// or refund/claim/commit when `expectedIntentHash` is omitted) skip
// the assertion harmlessly — local hash is still the value sent to
// the backend.
export function assertIntentHashMatch(
  expected: Hex | undefined,
  local: Hex,
): void {
  if (!expected) return;
  if (expected.toLowerCase() !== local.toLowerCase()) {
    throw new Error(
      `intent hash drift: expected ${expected} (preflight) !== ${local} (local recompute). ` +
        `Client envelope diverged from backend's canonical params — never sign past this. ` +
        `Re-run preflight and rebuild the envelope from its response.`,
    );
  }
}

// ─── Shared envelope sign + submit ───────────────────────────────────
//
// Sponsor and cosponsor build different witnesses + funds and broadcast
// through different chain entry points (sponsorSubmit vs submit), but
// the middle of the flow is byte-identical: recompute the EIP-712 hash,
// assert it matches the preflight `expectedIntentHash` (never sign past
// drift — R-INTENT-HASH-IS-MATCH-KEY), sign, and POST the Round-3
// unified-intent body `{actionType, typedData, content, signature,
// expectedIntentHash}`. This helper is that shared spine — extracting
// it keeps the two flows from re-duplicating ~40 LOC each and guarantees
// they post the identical wire shape (the divergence that broke Q9's
// cosponsor leg in the 10-Q swarm was a per-flow copy drifting out of
// sync). The witness payload key is `content`; the dispatcher accepts
// the legacy `witness` alias too, but new builds send `content`.
async function signAndSubmitEnvelope(p: {
  baseUrl: string;
  bearerToken: string;
  questionId: string;
  actionType: string;
  envelope: Envelope;
  serializedContent: Record<string, unknown>;
  expectedIntentHash: Hex;
  chainId: number;
  forgeAddress: Address;
  privateKey: Hex;
}): Promise<{ localIntentHash: Hex; signature: Hex; backendStatus?: string; backendIntentHash?: Hex }> {
  const typedData = buildEnvelopeForSigning({
    envelope: p.envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });
  const localIntentHash = hashEnvelopeStruct(p.envelope);
  assertIntentHashMatch(p.expectedIntentHash, localIntentHash);
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const submitBody = {
    actionType: p.actionType,
    typedData: serializeEnvelope(p.envelope),
    content: p.serializedContent,
    signature,
    expectedIntentHash: p.expectedIntentHash,
  };
  const res = await fetch(`${p.baseUrl}/v1/questions/${p.questionId}/intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.bearerToken}`,
      Prefer: "return=minimal",
    },
    body: stringifyWithBigInts(submitBody),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${p.actionType}: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${redactBearer(text)}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  return {
    localIntentHash,
    signature,
    backendStatus: parsed.status,
    backendIntentHash: (parsed.intentHash ?? localIntentHash) as Hex,
  };
}

// ─── USDC allowance gate ─────────────────────────────────────────────

/**
 * Ensures the signer's USDC allowance to the forge address is at least
 * `required`. If short, broadcasts a `approve(forge, MAX_UINT256)` tx
 * and waits for receipt. The MAX_UINT256 allowance is a one-time setup
 * cost — agents reuse it across every subsequent contribution.
 *
 * Returns the tx hash of the approve tx, or `null` when no approve was
 * needed.
 */
export async function ensureUsdcAllowance(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: { usdc: Address; forge: Address; owner: Address; required: bigint },
): Promise<Hex | null> {
  const current = await publicClient.readContract({
    address: params.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [params.owner, params.forge],
  });
  if (current >= params.required) {
    return null;
  }
  const MAX = (1n << 256n) - 1n;
  const txHash = await wallet.writeContract({
    address: params.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [params.forge, MAX],
    account: wallet.account!,
    chain: wallet.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

// ─── Sponsor flow ────────────────────────────────────────────────────

export interface SponsorFlowParams {
  baseUrl: string;
  bearerToken: string;
  signer: Address;
  /** App-level question id (qst_…) — used to build the unified intent
   *  URL `/v1/questions/:question_id/intents`. The chain-level `qid`
   *  (bytes32) still flows through the envelope below. */
  questionId: string;
  qid: Hex;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;

  /** Server-asserted intentHash from the preflight response. Posted
   *  verbatim on the unified submit so the dispatcher can mirror its
   *  Stage-2 reject if the client-recomputed hash drifts. */
  expectedIntentHash: Hex;

  // SponsorWitness fields (per-Q parameters frozen on first sponsor).
  title: string;
  body: string;
  criteria: string;
  tags: string[];
  oracle: Address;
  sponsorshipFloor: bigint;
  commitFee: bigint;
  voteFee: bigint;
  stakeFloor: bigint;
  stakeBasisPoints: number;
  fundingDeadline: bigint;
  noSolutionGracePeriod: bigint;

  // Funds the envelope binds.
  token: Address;
  amount: bigint; // → funds.poolIn
  feeAmount: bigint; // typically 0 for sponsor (chain config-dependent)
  feeShareBps: number;
  feeShares: FeeShare[];

  // Chain + backend clients.
  walletClient: WalletClient;
  /** Required ONLY for broadcasting. POST uses the wallet's signTypedData. */
  privateKey: Hex;
}

export interface SponsorFlowResult {
  intentHash: Hex;
  signature: Hex;
  envelope: Envelope;
  /** Whether the backend POST succeeded; null until step 4 runs. */
  backendStatus?: string;
  /** Chain tx hash; populated after step 5. */
  txHash?: Hex;
}

/**
 * Runs the full sponsor flow end-to-end. Throws after the backend POST
 * succeeds but before chain broadcast attempts with `stagedIntentHash`
 * embedded so the caller can wrap the partial-failure error.
 */
export async function runSponsorFlow(
  p: SponsorFlowParams,
): Promise<SponsorFlowResult> {
  // 1. Witness.
  const { witness, contentHash } = buildSponsorWitness({
    title: p.title,
    body: p.body,
    criteria: p.criteria,
    tags: p.tags,
    oracle: p.oracle,
    sponsorshipFloor: p.sponsorshipFloor,
    commitFee: p.commitFee,
    voteFee: p.voteFee,
    stakeFloor: p.stakeFloor,
    stakeBasisPoints: p.stakeBasisPoints,
    fundingDeadline: p.fundingDeadline,
    noSolutionGracePeriod: p.noSolutionGracePeriod,
  });

  // 2. Envelope.
  const funds: Funds = {
    token: p.token,
    poolIn: p.amount,
    poolOut: 0n,
    feeAmount: p.feeAmount,
    feeShareBps: p.feeShareBps,
    feeShares: p.feeShares,
    stakeAmount: 0n,
    stakeOp: StakeOp.None,
  };
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: ActionTag.Sponsor,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash,
    funds,
  };

  // 3+4. Sign (with pre-sign drift assert) + POST the Round-3 unified
  // intent body via the shared spine.
  const submitted = await signAndSubmitEnvelope({
    baseUrl: p.baseUrl,
    bearerToken: p.bearerToken,
    questionId: p.questionId,
    actionType: "sponsor",
    envelope,
    serializedContent: serializeSponsorWitness(witness),
    expectedIntentHash: p.expectedIntentHash,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
    privateKey: p.privateKey,
  });
  const result: SponsorFlowResult = {
    intentHash: submitted.backendIntentHash ?? submitted.localIntentHash,
    signature: submitted.signature,
    envelope,
    backendStatus: submitted.backendStatus,
  };
  const signature = submitted.signature;

  // 5. Chain broadcast.
  const txHash = await broadcastSponsorSubmit(p.walletClient, {
    forgeAddress: p.forgeAddress,
    envelope,
    signature,
    witness,
  });
  result.txHash = txHash;
  return result;
}

// ─── Cosponsor flow ──────────────────────────────────────────────────

export interface CosponsorFlowParams {
  baseUrl: string;
  bearerToken: string;
  signer: Address;
  /** App-level question id (qst_…) — used to build the unified intent
   *  URL `/v1/questions/:question_id/intents`. */
  questionId: string;
  qid: Hex;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;

  /** Server-asserted intentHash from the preflight response. */
  expectedIntentHash: Hex;

  // Funds. Cosponsor binds only the added pool amount + token. It
  // carries NO feeShares of its own and feeShareBps=0 — the fee-share
  // policy is frozen by the first sponsor; a cosponsor top-up only adds
  // to the pool. The backend's cosponsor preflight bakes the canonical
  // envelope with empty feeShares + feeShareBps=0 and computes
  // `expectedIntentHash` over THAT, and the chain shape gate enforces
  // it. There is therefore no feeShares/feeShareBps param here — the
  // flow hardcodes empty so a caller can't drift the envelope and crash
  // the submit with HTTP 400 / an intent-hash mismatch.
  token: Address;
  amount: bigint;
  feeAmount: bigint;

  walletClient: WalletClient;
  privateKey: Hex;
}

export interface CosponsorFlowResult {
  intentHash: Hex;
  signature: Hex;
  envelope: Envelope;
  backendStatus?: string;
  txHash?: Hex;
}

/**
 * Runs the cosponsor flow end-to-end. Cosponsor inherits q.token,
 * q.feeShareBps, q.feeShares from chain state; the envelope only
 * carries the amount to add.
 */
export async function runCosponsorFlow(
  p: CosponsorFlowParams,
): Promise<CosponsorFlowResult> {
  // 1+2. Witness + envelope. Cosponsor funds carry empty feeShares +
  // feeShareBps=0 — hardcoded, not caller-supplied, so the locally-built
  // envelope can never drift from the backend's canonical template
  // (preflight bakes the same empty array; the chain shape gate enforces
  // it). A stale non-empty fallback was what crashed Q9's cosponsor leg.
  const { witness, contentHash } = buildCosponsorWitness({ amount: p.amount });
  const funds: Funds = {
    token: p.token,
    poolIn: p.amount,
    poolOut: 0n,
    feeAmount: p.feeAmount,
    feeShareBps: 0,
    feeShares: [],
    stakeAmount: 0n,
    stakeOp: StakeOp.None,
  };
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: ActionTag.Cosponsor,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash,
    funds,
  };

  // 3+4. Sign (with pre-sign drift assert) + POST via the shared spine —
  // identical Round-3 wire shape to runSponsorFlow.
  const submitted = await signAndSubmitEnvelope({
    baseUrl: p.baseUrl,
    bearerToken: p.bearerToken,
    questionId: p.questionId,
    actionType: "cosponsor",
    envelope,
    serializedContent: serializeCosponsorWitness(witness),
    expectedIntentHash: p.expectedIntentHash,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
    privateKey: p.privateKey,
  });
  const result: CosponsorFlowResult = {
    intentHash: submitted.backendIntentHash ?? submitted.localIntentHash,
    signature: submitted.signature,
    envelope,
    backendStatus: submitted.backendStatus,
  };
  const signature = submitted.signature;

  // 5. Chain broadcast — universal `submit(env, sig)`.
  const txHash = await broadcastSubmit(p.walletClient, {
    forgeAddress: p.forgeAddress,
    envelope,
    signature,
  });
  result.txHash = txHash;
  return result;
}

// ─── Commit flow ─────────────────────────────────────────────────────

export interface CommitFlowParams {
  baseUrl: string;
  bearerToken: string;
  signer: Address;
  /** App-level question id (qst_…) — used to build the unified intent
   *  URL `/v1/questions/:question_id/intents`. */
  questionId: string;
  qid: Hex;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;

  /**
   * Server-asserted intentHash from the preflight response.
   * Optional for commit: the server cannot pre-compute it because the
   * contentHash (from the solution body) is unknown at preflight time.
   * When absent, runCommitFlow derives the hash locally from the built
   * envelope via hashEnvelopeStruct() — the universal intentHash per
   * R-INTENT-HASH-IS-MATCH-KEY, which the backend re-derives at Stage 2.
   */
  expectedIntentHash?: Hex;

  // CommitWitness fields.
  solutionBody: string;
  references: string[];

  // Funds shape — Commit requires feeAmount > 0, stakeAmount > 0,
  // stakeOp = Lock, poolIn = 0, poolOut = 0. feeShares MUST mirror the
  // question's frozen q.feeShares (basisPoints sum to 10000).
  token: Address;
  feeAmount: bigint;
  stakeAmount: bigint;
  feeShareBps: number;
  feeShares: FeeShare[];

  walletClient: WalletClient;
  privateKey: Hex;
}

export interface CommitFlowResult {
  intentHash: Hex;
  signature: Hex;
  envelope: Envelope;
  backendStatus?: string;
  txHash?: Hex;
}

/**
 * Runs the commit flow end-to-end. The chain entry point is
 * `submit(env, sig)` — no witness bytes (Commit's witness lives off-
 * chain; the chain only sees contentHash + envelope).
 */
export async function runCommitFlow(
  p: CommitFlowParams,
): Promise<CommitFlowResult> {
  const { witness, contentHash } = buildCommitWitness({
    solutionBody: p.solutionBody,
    references: p.references,
  });
  const funds: Funds = {
    token: p.token,
    poolIn: 0n,
    poolOut: 0n,
    feeAmount: p.feeAmount,
    feeShareBps: p.feeShareBps,
    feeShares: p.feeShares,
    stakeAmount: p.stakeAmount,
    stakeOp: StakeOp.Lock,
  };
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: ActionTag.Commit,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash,
    funds,
  };
  const typedData = buildEnvelopeForSigning({
    envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });
  // Compute intentHash locally from the fully-specified envelope.
  // The commit preflight cannot pre-compute this because contentHash is
  // derived from the solution body, which is only known here.
  // hashEnvelopeStruct is the universal intentHash per
  // R-INTENT-HASH-IS-MATCH-KEY — the same struct hash the backend
  // re-derives at Stage 2 and the chain emits as event.intent_hash.
  const localIntentHash = hashEnvelopeStruct(envelope);
  // R-INTENT-HASH-IS-MATCH-KEY: when preflight pre-asserted a hash
  // (rare for commit since contentHash is body-derived, but supported
  // by the API), enforce match before signing.
  assertIntentHashMatch(p.expectedIntentHash, localIntentHash);
  const intentHashToSend = p.expectedIntentHash ?? localIntentHash;

  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: CommitFlowResult = {
    intentHash: localIntentHash,
    signature,
    envelope,
  };

  const res = await fetch(
    `${p.baseUrl}/v1/questions/${p.questionId}/intents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.bearerToken}`,
        Prefer: "return=minimal",
      },
      body: stringifyWithBigInts({
        actionType: "commit",
        typedData: serializeEnvelope(envelope),
        content: serializeCommitWitness(witness),
        signature,
        expectedIntentHash: intentHashToSend,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runCommitFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${redactBearer(text)}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? localIntentHash) as Hex;
  result.backendStatus = parsed.status;

  const txHash = await broadcastSubmit(p.walletClient, {
    forgeAddress: p.forgeAddress,
    envelope,
    signature,
  });
  result.txHash = txHash;
  return result;
}

// ─── Vote flow ───────────────────────────────────────────────────────

export interface VoteFlowParams {
  baseUrl: string;
  bearerToken: string;
  signer: Address;
  /** App-level question id (qst_…) — used to build the unified intent
   *  URL `/v1/questions/:question_id/intents`. */
  questionId: string;
  qid: Hex;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;

  /** Server-asserted intentHash from the preflight response. */
  expectedIntentHash: Hex;

  // VoteWitness fields. `allocations[].solutionId` is the on-chain
  // solutionId — i.e. the SolutionCommitted event's intent_hash. `salt`
  // is the server-issued voteSalt from preflight (mixed into
  // allocationsHash to defeat rainbow-table enumeration).
  allocations: Allocation[];
  voteSalt: Hex;
  /** Server-issued HMAC token bound to (salt, signer, qid, expiresAt).
   *  Posted alongside envelope/witness/signature; the backend re-binds
   *  before persisting. NOT part of the signed envelope. */
  voteSaltToken: Hex;

  // Funds shape — Vote requires feeAmount > 0, stakeAmount > 0,
  // stakeOp = Lock, poolIn = 0, poolOut = 0. feeShares MUST mirror
  // q.feeShares.
  token: Address;
  feeAmount: bigint;
  stakeAmount: bigint;
  feeShareBps: number;
  feeShares: FeeShare[];

  walletClient: WalletClient;
  privateKey: Hex;
}

export interface VoteFlowResult {
  intentHash: Hex;
  signature: Hex;
  envelope: Envelope;
  backendStatus?: string;
  txHash?: Hex;
}

/**
 * Runs the vote flow end-to-end. Chain entry is `submit(env, sig)`.
 * The voteSaltToken rides outside the signed envelope — it's a
 * server-issued artifact the backend re-binds to the bearer wallet
 * before persisting (Audit-A5 HIGH gate).
 */
export async function runVoteFlow(
  p: VoteFlowParams,
): Promise<VoteFlowResult> {
  const { witness, contentHash } = buildVoteWitness({
    allocations: p.allocations,
    salt: p.voteSalt,
  });
  const funds: Funds = {
    token: p.token,
    poolIn: 0n,
    poolOut: 0n,
    feeAmount: p.feeAmount,
    feeShareBps: p.feeShareBps,
    feeShares: p.feeShares,
    stakeAmount: p.stakeAmount,
    stakeOp: StakeOp.Lock,
  };
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: ActionTag.Vote,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash,
    funds,
  };
  const typedData = buildEnvelopeForSigning({
    envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });
  // R-INTENT-HASH-IS-MATCH-KEY: recompute locally. A vote's intent hash
  // is allocation-dependent, so a vote preflight can only return an
  // empty-allocations placeholder (VotePreflight H-8) — callers therefore
  // pass expectedIntentHash undefined and this assert no-ops. The real
  // localIntentHash below is the claim the backend recomputes against at
  // Stage 2 (mirrors runCommitFlow's intentHashToSend pattern).
  const localIntentHash = hashEnvelopeStruct(envelope);
  assertIntentHashMatch(p.expectedIntentHash, localIntentHash);
  const intentHashToSend = p.expectedIntentHash ?? localIntentHash;
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: VoteFlowResult = {
    intentHash: localIntentHash,
    signature,
    envelope,
  };

  const res = await fetch(
    `${p.baseUrl}/v1/questions/${p.questionId}/intents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.bearerToken}`,
        Prefer: "return=minimal",
      },
      body: stringifyWithBigInts({
        actionType: "vote",
        typedData: serializeEnvelope(envelope),
        content: serializeVoteWitness(witness),
        signature,
        expectedIntentHash: intentHashToSend,
        voteSaltToken: p.voteSaltToken,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runVoteFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${redactBearer(text)}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? localIntentHash) as Hex;
  result.backendStatus = parsed.status;

  const txHash = await broadcastSubmit(p.walletClient, {
    forgeAddress: p.forgeAddress,
    envelope,
    signature,
  });
  result.txHash = txHash;
  return result;
}

// ─── Wire serialization ──────────────────────────────────────────────

// Go's stdlib JSON unmarshals *big.Int from JSON NUMBERS, not strings.
// Sending "1234" fails the bind with json.UnmarshalTypeError. We emit
// these via a sentinel marker + post-stringify regex pass so the wire
// JSON carries raw integer tokens (`"poolIn": 1000000` not
// `"poolIn": "1000000"`). USDC values fit in JS safe-int easily; if
// future tokens push past 2^53-1 we can switch to a streaming encoder.
const BIGINT_SENTINEL = "__BIGINT_SENTINEL__";

function encodeBigIntForWire(b: bigint): string {
  // Emit as a marker string at JSON build time; the regex pass strips
  // the quotes around it so Go receives a number literal.
  return `${BIGINT_SENTINEL}${b.toString()}`;
}

export function stringifyWithBigInts(obj: unknown): string {
  const raw = JSON.stringify(obj);
  // Strip the marker quotes: "__BIGINT_SENTINEL__1234" → 1234.
  return raw.replace(
    new RegExp(`"${BIGINT_SENTINEL}([0-9]+)"`, "g"),
    "$1",
  );
}

export function serializeSponsorWitness(
  w: import("../intents/sponsor-witness.js").SponsorWitness,
): Record<string, unknown> {
  return {
    actionTag: w.actionTag,
    title: w.title,
    body: w.body,
    criteria: w.criteria,
    tags: w.tags,
    oracle: w.oracle,
    sponsorshipFloor: encodeBigIntForWire(w.sponsorshipFloor),
    commitFee: encodeBigIntForWire(w.commitFee),
    voteFee: encodeBigIntForWire(w.voteFee),
    stakeFloor: encodeBigIntForWire(w.stakeFloor),
    stakeBasisPoints: w.stakeBasisPoints,
    fundingDeadline: encodeBigIntForWire(w.fundingDeadline),
    noSolutionGracePeriod: encodeBigIntForWire(w.noSolutionGracePeriod),
  };
}

function serializeCosponsorWitness(
  w: import("../intents/cosponsor-witness.js").CosponsorWitness,
): Record<string, unknown> {
  return {
    actionTag: w.actionTag,
    amount: encodeBigIntForWire(w.amount),
  };
}

export function serializeCommitWitness(w: CommitWitness): Record<string, unknown> {
  return {
    actionTag: w.actionTag,
    solutionBody: w.solutionBody,
    references: w.references,
  };
}

function serializeVoteWitness(w: VoteWitness): Record<string, unknown> {
  return {
    actionTag: w.actionTag,
    allocations: w.allocations.map((a) => ({
      solutionId: a.solutionId,
      basisPoints: a.basisPoints,
    })),
    salt: w.salt,
  };
}

export function serializeEnvelope(e: Envelope): Record<string, unknown> {
  return {
    signer: e.signer,
    questionId: e.qid,
    action: e.action,
    nonce: encodeBigIntForWire(e.nonce),
    // Audit H1: bigint → wire-int via the same sentinel pattern as
    // every other uint256. `Number(bigint)` was silently lossy for
    // values past 2^53-1, and the inconsistency with the rest of the
    // envelope fields was a foot-gun for future deadlines that scale
    // beyond timestamp range.
    expiresAt: encodeBigIntForWire(e.expiresAt),
    contentHash: e.contentHash,
    funds: {
      token: e.funds.token,
      poolIn: encodeBigIntForWire(e.funds.poolIn),
      poolOut: encodeBigIntForWire(e.funds.poolOut),
      feeAmount: encodeBigIntForWire(e.funds.feeAmount),
      feeShareBps: e.funds.feeShareBps,
      feeShares: e.funds.feeShares,
      stakeAmount: encodeBigIntForWire(e.funds.stakeAmount),
      stakeOp: e.funds.stakeOp,
    },
  };
}

function serializeAbandonWitness(w: AbandonWitness): Record<string, unknown> {
  return {
    actionTag: w.actionTag,
    expectedStatus: w.expectedStatus,
    reason: w.reason,
  };
}

function serializeRefundWitness(w: RefundWitness): Record<string, unknown> {
  return {
    actionTag: w.actionTag,
    sourceIntentHash: w.sourceIntentHash,
    expectedAmount: encodeBigIntForWire(w.expectedAmount),
    expectedStatus: w.expectedStatus,
  };
}

function serializeSettleWitness(w: SettleWitness): Record<string, unknown> {
  return {
    actionTag: w.actionTag,
    merkleRoot: w.merkleRoot,
    totalClaimable: encodeBigIntForWire(w.totalClaimable),
    feeTotal: encodeBigIntForWire(w.feeTotal),
    slashes: w.slashes.map((s: SlashEntry) => ({
      intentHash: s.intentHash,
      amount: encodeBigIntForWire(s.amount),
      role: s.role,
    })),
    leafCount: encodeBigIntForWire(w.leafCount),
    slashEntryOffset: encodeBigIntForWire(w.slashEntryOffset),
    totalSlashEntries: encodeBigIntForWire(w.totalSlashEntries),
    feeDistributions: w.feeDistributions.map((f: FeeDistribution) => ({
      recipient: f.recipient,
      amount: encodeBigIntForWire(f.amount),
    })),
  };
}

// ─── Abandon flow ────────────────────────────────────────────────────
//
// Permissionless Open→Abandoned transition by the question's oracle.
// (Note: the chain restricts Abandon to `env.signer == q.oracle`;
//  rev2 §10.1 C1-sm. Anyone-can-abandon comes via forceRecover
//  post-`recoverableAt`, a different path.)
//
// AUDIT C1 FIX — the earlier version of this flow skipped the backend
// POST and broadcast directly. That broke the reconciler: when the
// chain Abandon event arrived, the cycle-runner's LEFT JOIN against
// signed_intents found no row, processOne classified the event as
// OutcomeHeld, and the question's DB status stayed `open` forever
// even though the chain said `Abandoned`. Exactly the R-CHAIN-IS-
// AUTHORITY drift this codebase exists to prevent. We POST a staged
// row first, then broadcast — mirroring runRefundFlow / runClaimFlow.
//
// Preflight is not available (intent.go dispatcher returns 501 for
// `abandon` — PR2 roadmap), so the caller computes the envelope
// fields locally. The submit endpoint accepts the staged row even
// without preflight (per the 501's recovery action string itself).

export interface AbandonFlowParams {
  signer: Address;
  qid: Hex;
  questionId: string;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;
  /** USDC (or whatever the question's bountyToken is). The chain
   *  rejects token-zero in the funds shape gate even though Abandon
   *  moves no funds. Pass the question's chain_token verbatim. */
  token: Address;
  /** Reason encoded as a bytes32 string. Common values mirror
   *  questions.abandonment_reason: 'timeout' / 'no_solutions' /
   *  'owner_cancelled'. Pad/zero-pad to 32 bytes via stringToHex(...,
   *  { size: 32 }) at the call site. */
  reason: Hex;
  /** On-chain QuestionStatus the signer expects (the chain's enum
   *  Open=1). The contract reverts on mismatch — defense against
   *  signing into a status the signer didn't intend. */
  expectedStatus: number;
  /** Backend bearer JWT for the POST /intents stage. Required (the
   *  staged row is the reconciler's match key — see C1 fix above). */
  bearerToken: string;
  /** API base url (http://localhost:8080 in dev). */
  baseUrl: string;
  walletClient: WalletClient;
  privateKey: Hex;
}

export interface AbandonFlowResult {
  intentHash: Hex;
  signature: Hex;
  envelope: Envelope;
  backendStatus?: string;
  txHash?: Hex;
}

export async function runAbandonFlow(
  p: AbandonFlowParams,
): Promise<AbandonFlowResult> {
  const { witness, contentHash } = buildAbandonWitness({
    expectedStatus: p.expectedStatus,
    reason: p.reason,
  });
  // Abandon funds-shape (QuadphaseShapes.assertFundsShape): all
  // amounts zero, stakeOp=None, but token MUST be non-zero per the
  // shared "shape:token-must-be-nonzero" gate that fires before the
  // per-action branch.
  const funds: Funds = {
    token: p.token,
    poolIn: 0n,
    poolOut: 0n,
    feeAmount: 0n,
    feeShareBps: 0,
    feeShares: [],
    stakeAmount: 0n,
    stakeOp: StakeOp.None,
  };
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: ActionTag.Abandon,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash,
    funds,
  };
  const typedData = buildEnvelopeForSigning({
    envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });
  const intentHash = hashEnvelopeStruct(envelope);
  // R-INTENT-HASH-IS-MATCH-KEY: abandon has no preflight today so the
  // local hash is the canonical value sent forward; this no-ops, but
  // keeps the assertion site uniform across every flow for future
  // preflight wiring.
  assertIntentHashMatch(undefined, intentHash);
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: AbandonFlowResult = {
    intentHash,
    signature,
    envelope,
  };

  // C1: stage the row in the backend BEFORE broadcasting. The
  // reconciler can only confirm chain events whose intent_hash
  // matches a staged signed_intents row.
  const res = await fetch(
    `${p.baseUrl}/v1/questions/${p.questionId}/intents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.bearerToken}`,
        Prefer: "return=minimal",
      },
      body: stringifyWithBigInts({
        actionType: "abandon",
        typedData: serializeEnvelope(envelope),
        content: serializeAbandonWitness(witness),
        signature,
        expectedIntentHash: intentHash,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    // C2: redact any echoed Authorization header before it reaches
    // the LLM's error message.
    throw new Error(
      `runAbandonFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${redactBearer(text)}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? intentHash) as Hex;
  result.backendStatus = parsed.status;

  // C: Abandon broadcasts through `abandonSubmit(env, sig, witnessBytes)`,
  // NOT the plain `submit(env, sig)` — `submit()` now REVERTS
  // "submit:abandon-needs-witness" for an Abandon envelope. The witness
  // built above (buildAbandonWitness) is abi-encoded inside the helper so
  // the chain can recompute env.contentHash and read expectedStatus +
  // reason.
  const txHash = await broadcastAbandonSubmit(p.walletClient, {
    forgeAddress: p.forgeAddress,
    envelope,
    signature,
    witness,
  });
  result.txHash = txHash;
  return result;
}

// ─── Refund flow ─────────────────────────────────────────────────────
//
// Per-actor "pull my funds back from an Abandoned (or Settled with
// un-slashed remainder) question" flow. Three sub-paths share this
// shape:
//
//   sourceIntentHash == bytes32(0) → sponsor / cosponsor refund:
//     contract releases sponsorContributions[qid][signer] (the
//     signer's cumulative bounty contribution on this question).
//   sourceIntentHash != 0 → commit / vote stake refund: contract
//     releases stakes[ih] iff stakeOwner[ih] == env.signer.
//
// Backend preflight (`actionType=refund` → RefundDraft) returns the
// envelope template + expectedAmount + sourceIntentHash. If the
// caller already has those values (e.g. queried directly from
// chain), they can skip preflight and pass them in — the backend
// POST is still needed to stage the signed_intents row for
// post-confirm projection.

export interface RefundFlowParams {
  signer: Address;
  qid: Hex;
  questionId: string;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;
  token: Address;
  /** bytes32(0) for sponsor refund; the committed solution/vote
   *  intentHash for stake refunds. */
  sourceIntentHash: Hex;
  /** Exact amount the contract will release. The witness encodes
   *  this; mismatch reverts with 'refund:amount-mismatch'. Preflight
   *  populates it from sponsorContributions/stakes lookup. */
  expectedAmount: bigint;
  /** On-chain QuestionStatus enum the signer expects:
   *  Abandoned=4, Settled=3. The contract reverts on mismatch. */
  expectedStatus: number;
  /** Backend bearer JWT for the POST /intents stage. */
  bearerToken: string;
  /** API base url (http://localhost:8080 in dev). */
  baseUrl: string;
  /** Optional pre-computed intent hash from preflight. When omitted,
   *  the flow derives it locally and uses that. */
  expectedIntentHash?: Hex;
  walletClient: WalletClient;
  privateKey: Hex;
}

export interface RefundFlowResult {
  intentHash: Hex;
  signature: Hex;
  envelope: Envelope;
  backendStatus?: string;
  txHash?: Hex;
}

export async function runRefundFlow(
  p: RefundFlowParams,
): Promise<RefundFlowResult> {
  // AUDIT H2: validate sourceIntentHash up-front. The chain expects
  // bytes32 (66 chars including `0x`). Without this guard, a caller
  // passing `0x00` (66 chars short) would silently bypass the
  // zero-sentinel check at the StakeOp decision, set the wrong
  // stakeOp, and produce an opaque chain revert rather than a clear
  // client-side type error.
  if (!BYTES32_RE.test(p.sourceIntentHash)) {
    throw new Error(
      `runRefundFlow: sourceIntentHash must be 0x + 64 hex chars (bytes32); got "${p.sourceIntentHash}" (${p.sourceIntentHash.length} chars)`,
    );
  }
  const { witness, contentHash } = buildRefundWitness({
    sourceIntentHash: p.sourceIntentHash,
    expectedAmount: p.expectedAmount,
    expectedStatus: p.expectedStatus,
  });
  // Refund funds-shape: poolOut = expectedAmount, everything else zero,
  // stakeOp = None for BOTH sponsor and stake refunds. The contract
  // disambiguates sponsor-vs-stake by sourceIntentHash (== 0 ⇒ sponsor),
  // NOT by stakeOp, and the backend's canonical refund envelope
  // (newRefundFunds) hashes StakeOp.None unconditionally — so the client
  // must use None too or the envelope hash drifts from the backend's
  // expectedIntentHash on every stake refund. #629.
  const funds: Funds = {
    token: p.token,
    poolIn: 0n,
    poolOut: p.expectedAmount,
    feeAmount: 0n,
    feeShareBps: 0,
    feeShares: [],
    stakeAmount: 0n,
    stakeOp: StakeOp.None,
  };
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: ActionTag.Refund,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash,
    funds,
  };
  const typedData = buildEnvelopeForSigning({
    envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });
  const localIntentHash = hashEnvelopeStruct(envelope);
  // R-INTENT-HASH-IS-MATCH-KEY: refund preflight (RefundDraft) returns
  // expectedIntentHash when available; assert before signing.
  assertIntentHashMatch(p.expectedIntentHash, localIntentHash);
  const intentHashToSend = p.expectedIntentHash ?? localIntentHash;
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: RefundFlowResult = {
    intentHash: localIntentHash,
    signature,
    envelope,
  };

  const res = await fetch(
    `${p.baseUrl}/v1/questions/${p.questionId}/intents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.bearerToken}`,
        Prefer: "return=minimal",
      },
      body: stringifyWithBigInts({
        actionType: "refund",
        typedData: serializeEnvelope(envelope),
        content: serializeRefundWitness(witness),
        signature,
        expectedIntentHash: intentHashToSend,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runRefundFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${redactBearer(text)}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? localIntentHash) as Hex;
  result.backendStatus = parsed.status;

  const witnessBytes = encodeRefundWitnessBytes(witness);
  const txHash = await broadcastPullValue(p.walletClient, {
    forgeAddress: p.forgeAddress,
    envelope,
    signature,
    witnessBytes,
  });
  result.txHash = txHash;
  return result;
}

// ─── Claim flow ──────────────────────────────────────────────────────
//
// Winner's pull-side flow for Settled questions. PERMISSIONLESS + UNSIGNED
// (contract A+G): the oracle-signed settlementRoot already fixed the
// entitlement, and the Merkle proof IS the authorisation. So there is NO
// envelope, NO signature, and NO backend /intents POST for a claim — the
// flow reads the leaf (recipient, role, leafIndex, leafAmount) + Merkle
// proof from the backend claim/withdraw preflight (ClaimDraft, sourced
// from the persisted root-verified leaf set — leafset single-source) and
// calls the contract's `claim(...)` directly. The chain recomputes
// leaf = keccak256(abi.encode(qid, recipient, role, leafIndex,
// leafAmount)), verifies it against the stored root via `proof`, dedups,
// and transfers `leafAmount` to `recipient` — pay-to-recipient is
// structural, msg.sender (whoever holds gas) is irrelevant.
//
// (The legacy pullValue(Claim)-via-signed-ClaimWitness path was removed;
// pullValue is REFUND-ONLY now and reverts "pull:wrong-action" on a Claim
// envelope. Refund still rides runRefundFlow → pullValue, unchanged.)

export interface ClaimFlowParams {
  /** The leaf's committed recipient — funds go HERE. Sourced verbatim
   *  from the ClaimDraft's `recipient` (which is the winner's wallet).
   *  Claim is permissionless, so this need not equal the broadcasting
   *  wallet; the contract pays the leaf's recipient regardless. */
  recipient: Address;
  qid: Hex;
  forgeAddress: Address;
  /** Merkle proof from preflight (Round-3 ClaimDraft response). */
  proof: Hex[];
  leafIndex: bigint;
  leafAmount: bigint;
  /** Role byte for dual-role disambiguation (winner_creator=1 / voter /
   *  sponsor — see contract for the enum). It is part of the leaf the
   *  proof authorises. */
  role: number;
  /** The wallet that broadcasts (pays gas). Funds still go to
   *  `recipient`, not this wallet's account. */
  walletClient: WalletClient;
  /** Optional gas override for the claim tx. */
  gas?: bigint;
}

export interface ClaimFlowResult {
  /** Chain tx hash of the claim() broadcast. */
  txHash: Hex;
  /** Echoed leaf identity for the caller's reporting. */
  recipient: Address;
  role: number;
  leafIndex: bigint;
  leafAmount: bigint;
}

/**
 * Broadcasts a single settlement-leaf claim via the permissionless,
 * unsigned `claim(...)` entry point. No envelope, no signature, no
 * backend POST — the Merkle proof is the authorisation and funds go to
 * the leaf's `recipient`.
 */
export async function runClaimFlow(
  p: ClaimFlowParams,
): Promise<ClaimFlowResult> {
  const txHash = await broadcastClaim(p.walletClient, {
    forgeAddress: p.forgeAddress,
    qid: p.qid,
    recipient: p.recipient,
    role: p.role,
    leafIndex: p.leafIndex,
    leafAmount: p.leafAmount,
    proof: p.proof,
    ...(p.gas ? { gas: p.gas } : {}),
  });
  return {
    txHash,
    recipient: p.recipient,
    role: p.role,
    leafIndex: p.leafIndex,
    leafAmount: p.leafAmount,
  };
}

// ─── Settle flow ─────────────────────────────────────────────────────
//
// Oracle's settlement-publication flow. The signer is the question's
// oracle (the address bound on-chain via sponsorSubmit). The witness
// carries the chain-critical fields the universal Envelope can't hold:
// merkleRoot, totalClaimable, feeTotal, the slash set, the per-recipient
// feeDistributions, and the chunked-publish offsets. The contract flips
// Open → Settling on the
// first chunk and Settling → Settled on the final chunk (when
// slashEntryOffset + slashes.length == totalSlashEntries).
//
// Mirrors runClaimFlow / runRefundFlow exactly:
//   1. build SettleWitness (+ contentHash) from oracle-computed inputs.
//   2. build Envelope(action=Settle) — Settle funds-shape is all-zero
//      with token = q.token (the funds-shape gate requires non-zero
//      token even though settle moves no envelope-level funds; slash
//      moves happen inside the contract).
//   3. EIP-712 sign the envelope.
//   4. recompute hashEnvelopeStruct + assertIntentHashMatch
//      (R-INTENT-HASH-IS-MATCH-KEY) before signing past it.
//   5. POST /v1/questions/:id/intents actionType="settle" to stage the
//      signed_intents row so the reconciler can match the chain event
//      by intent_hash (R-RECONCILER-OWNS-CONFIRMATION). The backend
//      submit dispatcher accepts settle and returns 202 (the per-action
//      settlement content write is reconciler-owned; the staged row IS
//      the match key). If the POST is unavailable (older backend), pass
//      skipBackendPost=true to broadcast-only — the chain still settles,
//      but the reconciler can't confirm until a row exists.
//   6. broadcastSettle → publishSettlement(env, sig, witnessBytes).

export interface SettleFlowParams {
  signer: Address; // the question's oracle
  qid: Hex;
  questionId: string;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;
  /** The question's bountyToken. The funds-shape gate rejects
   *  token-zero even though settle moves no envelope-level funds. */
  token: Address;

  // SettleWitness fields — computed by the oracle (off-chain merkle
  // tree build + slash determination + realized-outcome fee aggregation).
  merkleRoot: Hex;
  totalClaimable: bigint;
  /** Total fee skimmed at settlement (economics.md §0). The contract
   *  pins it to `poolAmount × q.feeShareBps / 10000`; Σ feeDistributions
   *  amounts must equal it. Renamed from the pre-revision `dustFolded`. */
  feeTotal: bigint;
  slashes: SlashEntry[];
  leafCount: bigint;
  slashEntryOffset: bigint;
  totalSlashEntries: bigint;
  /** Per-recipient fee credits (platform first, then referrers),
   *  aggregated by the oracle. Credited to accruedFees[recipient][token]
   *  by the contract; empty when feeTotal == 0. */
  feeDistributions: FeeDistribution[];

  /** Backend bearer JWT for the POST /intents stage. Required unless
   *  skipBackendPost is set. */
  bearerToken?: string;
  /** API base url (http://localhost:8080 in dev). */
  baseUrl?: string;
  /** Broadcast-only mode: skip the backend POST. Use only when the
   *  backend's intent dispatcher doesn't accept actionType="settle"
   *  (e.g. an older deploy). Leaves the row unstaged — the reconciler
   *  can't confirm until a matching signed_intents row exists. */
  skipBackendPost?: boolean;
  /** Optional pre-computed intent hash. When omitted, derived locally. */
  expectedIntentHash?: Hex;
  walletClient: WalletClient;
  privateKey: Hex;
}

export interface SettleFlowResult {
  intentHash: Hex;
  signature: Hex;
  envelope: Envelope;
  witness: SettleWitness;
  backendStatus?: string;
  /** True when the backend POST was skipped (broadcast-only mode). */
  backendSkipped?: boolean;
  txHash?: Hex;
}

export async function runSettleFlow(
  p: SettleFlowParams,
): Promise<SettleFlowResult> {
  // 1. Witness.
  const { witness, contentHash } = buildSettleWitness({
    merkleRoot: p.merkleRoot,
    totalClaimable: p.totalClaimable,
    feeTotal: p.feeTotal,
    slashes: p.slashes,
    leafCount: p.leafCount,
    slashEntryOffset: p.slashEntryOffset,
    totalSlashEntries: p.totalSlashEntries,
    feeDistributions: p.feeDistributions,
  });

  // 2. Envelope — Settle funds-shape: all amounts zero, stakeOp None,
  // token non-zero (shared funds-shape gate).
  const funds: Funds = {
    token: p.token,
    poolIn: 0n,
    poolOut: 0n,
    feeAmount: 0n,
    feeShareBps: 0,
    feeShares: [],
    stakeAmount: 0n,
    stakeOp: StakeOp.None,
  };
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: ActionTag.Settle,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash,
    funds,
  };

  // 3 + 4. Recompute + assert before signing (R-INTENT-HASH-IS-MATCH-KEY).
  const typedData = buildEnvelopeForSigning({
    envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });
  const localIntentHash = hashEnvelopeStruct(envelope);
  assertIntentHashMatch(p.expectedIntentHash, localIntentHash);
  const intentHashToSend = p.expectedIntentHash ?? localIntentHash;
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: SettleFlowResult = {
    intentHash: localIntentHash,
    signature,
    envelope,
    witness,
  };

  // 5. Backend POST — stage the signed_intents row so the reconciler
  // matches the chain Settle event by intent_hash. Skippable for
  // broadcast-only operation against a backend whose dispatcher
  // doesn't route actionType="settle".
  if (p.skipBackendPost) {
    result.backendSkipped = true;
  } else {
    if (!p.bearerToken || !p.baseUrl) {
      throw new Error(
        "runSettleFlow: bearerToken + baseUrl are required unless skipBackendPost is set",
      );
    }
    const res = await fetch(
      `${p.baseUrl}/v1/questions/${p.questionId}/intents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.bearerToken}`,
          Prefer: "return=minimal",
        },
        body: stringifyWithBigInts({
          actionType: "settle",
          typedData: serializeEnvelope(envelope),
          content: serializeSettleWitness(witness),
          signature,
          expectedIntentHash: intentHashToSend,
        }),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `runSettleFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${redactBearer(text)}`,
      );
    }
    const parsed = JSON.parse(text) as {
      intentHash?: string;
      status?: string;
    };
    result.intentHash = (parsed.intentHash ?? localIntentHash) as Hex;
    result.backendStatus = parsed.status;
  }

  // 6. Chain broadcast.
  const txHash = await broadcastSettle(p.walletClient, {
    forgeAddress: p.forgeAddress,
    envelope,
    signature,
    witness,
  });
  result.txHash = txHash;
  return result;
}
