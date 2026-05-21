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
  hashTypedData,
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
  broadcastSponsorSubmit,
  broadcastSubmit,
} from "./quadphase-broadcast.js";

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

  // 3. Sign.
  const typedData = buildEnvelopeForSigning({
    envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: SponsorFlowResult = {
    intentHash: "0x" as Hex, // backend fills this in step 4
    signature,
    envelope,
  };

  // 4. Backend POST — Round-3 unified intent dispatcher. `typedData`
  // is the envelope JSON (the dispatcher wraps it into the existing
  // QuadphaseSubmit shape server-side); `content` carries the witness
  // fields.
  const submitBody = {
    actionType: "sponsor",
    typedData: serializeEnvelope(envelope),
    content: serializeSponsorWitness(witness),
    signature,
    expectedIntentHash: p.expectedIntentHash,
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
      body: stringifyWithBigInts(submitBody),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runSponsorFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const parsed = JSON.parse(text) as {
    intentHash?: string;
    status?: string;
  };
  result.intentHash = (parsed.intentHash ?? p.expectedIntentHash) as Hex;
  result.backendStatus = parsed.status;

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

  // Funds.
  token: Address;
  amount: bigint;
  feeAmount: bigint;
  feeShareBps: number;
  feeShares: FeeShare[];

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
  const { witness, contentHash } = buildCosponsorWitness({ amount: p.amount });
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
    action: ActionTag.Cosponsor,
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
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: CosponsorFlowResult = {
    intentHash: "0x" as Hex,
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
        actionType: "cosponsor",
        typedData: serializeEnvelope(envelope),
        content: serializeCosponsorWitness(witness),
        signature,
        expectedIntentHash: p.expectedIntentHash,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runCosponsorFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? p.expectedIntentHash) as Hex;
  result.backendStatus = parsed.status;

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
   * envelope and typed data via hashTypedData() — which is the canonical
   * value the backend will recompute at Stage 2 anyway.
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
  // hashTypedData produces the same EIP-712 hash the backend re-derives
  // at Stage 2 (R-FOUR-STAGE-VALIDATION), so this is the canonical value.
  const localIntentHash = hashTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  }) as Hex;
  const intentHashToSend = p.expectedIntentHash ?? localIntentHash;

  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: CommitFlowResult = {
    intentHash: "0x" as Hex,
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
      `runCommitFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? p.expectedIntentHash) as Hex;
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
  const account = privateKeyToAccount(p.privateKey);
  const signature = (await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  })) as Hex;

  const result: VoteFlowResult = {
    intentHash: "0x" as Hex,
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
        expectedIntentHash: p.expectedIntentHash,
        voteSaltToken: p.voteSaltToken,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runVoteFlow: POST /v1/questions/${p.questionId}/intents failed: HTTP ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? p.expectedIntentHash) as Hex;
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

function serializeSponsorWitness(
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

function serializeCommitWitness(w: CommitWitness): Record<string, unknown> {
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

function serializeEnvelope(e: Envelope): Record<string, unknown> {
  return {
    signer: e.signer,
    questionId: e.qid,
    action: e.action,
    nonce: encodeBigIntForWire(e.nonce),
    expiresAt: Number(e.expiresAt),
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
