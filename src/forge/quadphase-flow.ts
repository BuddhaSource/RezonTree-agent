// quadphase-flow.ts — end-to-end Quadphase v2 submit flow helpers.
//
// One helper per action that wraps:
//
//   1. Build witness (per-action shape) + contentHash.
//   2. Build envelope (signer + qid + action + nonce + expiresAt +
//      contentHash + funds) from preflight-advertised params.
//   3. EIP-712 sign the envelope via the agent's wallet.
//   4. POST /v1/quadphase/submit (backend stages the row).
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
} from "../intents/envelope.js";
import { buildSponsorWitness } from "../intents/sponsor-witness.js";
import { buildCosponsorWitness } from "../intents/cosponsor-witness.js";
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
  qid: Hex;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;

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

  // 4. Backend POST.
  const submitBody = {
    envelope: serializeEnvelope(envelope),
    witness,
    signature,
  };
  const res = await fetch(`${p.baseUrl}/v1/quadphase/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.bearerToken}`,
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(submitBody),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runSponsorFlow: POST /v1/quadphase/submit failed: HTTP ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const parsed = JSON.parse(text) as {
    intentHash?: string;
    status?: string;
  };
  result.intentHash = (parsed.intentHash ?? "0x") as Hex;
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
  qid: Hex;
  nonce: bigint;
  expiresAt: bigint;
  forgeAddress: Address;
  chainId: number;

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

  const res = await fetch(`${p.baseUrl}/v1/quadphase/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.bearerToken}`,
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      envelope: serializeEnvelope(envelope),
      witness,
      signature,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `runCosponsorFlow: POST /v1/quadphase/submit failed: HTTP ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const parsed = JSON.parse(text) as { intentHash?: string; status?: string };
  result.intentHash = (parsed.intentHash ?? "0x") as Hex;
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

function serializeEnvelope(e: Envelope): Record<string, unknown> {
  return {
    signer: e.signer,
    questionId: e.qid,
    action: e.action,
    nonce: e.nonce.toString(),
    expiresAt: Number(e.expiresAt),
    contentHash: e.contentHash,
    funds: {
      token: e.funds.token,
      poolIn: e.funds.poolIn.toString(),
      poolOut: e.funds.poolOut.toString(),
      feeAmount: e.funds.feeAmount.toString(),
      feeShareBps: e.funds.feeShareBps,
      feeShares: e.funds.feeShares,
      stakeAmount: e.funds.stakeAmount.toString(),
      stakeOp: e.funds.stakeOp,
    },
  };
}
