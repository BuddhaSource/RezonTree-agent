// client.ts — Router v2 write client. Wraps viem's writeContract
// for the four agent-facing entry points (fund, commitSolution,
// castVote, claim).
//
// Scope boundary: the SDK's job here is calldata + broadcast +
// receipt wait. It does NOT sign the intent — intent signing
// lives in src/intents/*. It does NOT construct the USDC permit
// signature — that's the caller's responsibility (build via
// `signPermit` from the agent's wallet key against the USDC
// contract's permit typehash). The router client just takes
// fully-formed (intent, intentSig, permitV/R/S) and broadcasts.
//
// R-CHAIN-VERIFIES-INTENT — Router verifies the signature
// on-chain; the client doesn't re-check.
// R-REUSE-FIRST — viem's writeContract + waitForTransactionReceipt
// handle the RPC + nonce + receipt plumbing.

import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type {
  CommitIntentMessage,
} from "../intents/commit-intent.js";
import type { FundIntentMessage } from "../intents/fund-intent.js";
import type { VoteIntentMessage } from "../intents/vote-intent.js";
import { ROUTER_V2_ABI } from "./abi.js";

/**
 * Permit signature bundle — the USDC EIP-2612 permit that
 * authorizes the Router to pull tokens. Router v2 expects these
 * three components passed as separate args (compat with existing
 * USDC ABI that doesn't support a combined 65-byte sig arg).
 */
export interface PermitSig {
  v: number; // uint8 — 27 or 28
  r: Hex; // bytes32
  s: Hex; // bytes32
}

/**
 * Constructs a WalletClient for an agent. Uses viem's
 * `privateKeyToAccount` so the raw 0x-prefixed private-key hex
 * from the agent's HD derivation (src/wallet/derive.ts) is
 * accepted directly.
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

// ─── fund() ─────────────────────────────────────────────────────

export interface BroadcastFundParams {
  routerAddress: Address;
  intent: FundIntentMessage;
  intentSig: Hex;
  permit: PermitSig;
}

/**
 * Broadcasts `Router.fund(intent, sig, permitV, permitR, permitS)`.
 * Caller's WalletClient must already be authenticated for the
 * funder's address (so `msg.sender` matches `intent.funder` —
 * Router's `_verifyIntent` rejects otherwise).
 */
export async function broadcastFund(
  wallet: WalletClient,
  params: BroadcastFundParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.routerAddress,
    abi: ROUTER_V2_ABI,
    functionName: "fund",
    args: [
      {
        questionId: params.intent.questionId,
        funder: params.intent.funder,
        amount: params.intent.amount,
        nonce: params.intent.nonce,
        chainId: params.intent.chainId,
        expiresAt: params.intent.expiresAt,
      },
      params.intentSig,
      params.permit.v,
      params.permit.r,
      params.permit.s,
    ],
    account: wallet.account as Account,
    chain: wallet.chain,
  });
}

// ─── commitSolution() ──────────────────────────────────────────

export interface BroadcastCommitParams {
  routerAddress: Address;
  intent: CommitIntentMessage;
  intentSig: Hex;
  permit: PermitSig;
}

export async function broadcastCommit(
  wallet: WalletClient,
  params: BroadcastCommitParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.routerAddress,
    abi: ROUTER_V2_ABI,
    functionName: "commitSolution",
    args: [
      {
        questionId: params.intent.questionId,
        submitter: params.intent.submitter,
        contentHash: params.intent.contentHash,
        feeAmount: params.intent.feeAmount,
        bondAmount: params.intent.bondAmount,
        nonce: params.intent.nonce,
        chainId: params.intent.chainId,
        expiresAt: params.intent.expiresAt,
      },
      params.intentSig,
      params.permit.v,
      params.permit.r,
      params.permit.s,
    ],
    account: wallet.account as Account,
    chain: wallet.chain,
  });
}

// ─── castVote() ────────────────────────────────────────────────

export interface BroadcastVoteParams {
  routerAddress: Address;
  intent: VoteIntentMessage;
  intentSig: Hex;
  permit: PermitSig;
}

export async function broadcastVote(
  wallet: WalletClient,
  params: BroadcastVoteParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.routerAddress,
    abi: ROUTER_V2_ABI,
    functionName: "castVote",
    args: [
      {
        questionId: params.intent.questionId,
        voter: params.intent.voter,
        allocationsHash: params.intent.allocationsHash,
        feeAmount: params.intent.feeAmount,
        bondAmount: params.intent.bondAmount,
        nonce: params.intent.nonce,
        chainId: params.intent.chainId,
        expiresAt: params.intent.expiresAt,
      },
      params.intentSig,
      params.permit.v,
      params.permit.r,
      params.permit.s,
    ],
    account: wallet.account as Account,
    chain: wallet.chain,
  });
}

// ─── claim() ───────────────────────────────────────────────────

export interface BroadcastClaimParams {
  routerAddress: Address;
  questionId: Hex;
  amount: bigint;
  proof: Hex[];
}

export async function broadcastClaim(
  wallet: WalletClient,
  params: BroadcastClaimParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.routerAddress,
    abi: ROUTER_V2_ABI,
    functionName: "claim",
    args: [params.questionId, params.amount, params.proof],
    account: wallet.account as Account,
    chain: wallet.chain,
  });
}

// ─── publishSettlement() — oracle path ─────────────────────────

export interface BroadcastPublishSettlementParams {
  routerAddress: Address;
  questionId: Hex;
  merkleRoot: Hex;
  expiresAt: bigint;
  slashedCommitHashes: readonly Hex[];
  slashedVoteHashes: readonly Hex[];
  oracleSig: Hex;
}

/** Broadcasts `Router.publishSettlement(qid, root, expiresAt,
 *  slashedCommit, slashedVote, sig)`. Caller must be the oracle
 *  address set in Router's constructor. Slashed bonds move into
 *  the pool atomically with the root commit.
 */
export async function broadcastPublishSettlement(
  wallet: WalletClient,
  params: BroadcastPublishSettlementParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.routerAddress,
    abi: ROUTER_V2_ABI,
    functionName: "publishSettlement",
    args: [
      params.questionId,
      params.merkleRoot,
      params.expiresAt,
      params.slashedCommitHashes as Hex[],
      params.slashedVoteHashes as Hex[],
      params.oracleSig,
    ],
    account: wallet.account as Account,
    chain: wallet.chain,
  });
}

// ─── Receipt wait helper ───────────────────────────────────────

/**
 * Awaits the transaction receipt + asserts `status === "success"`.
 * Throws on revert with the tx hash so the caller can explore
 * the failure on the block explorer.
 *
 * Caller supplies a `PublicClient` — construction of one is
 * cheap, but we don't create it inside writeContract wrappers
 * because a long-lived client amortizes across many broadcasts.
 */
export async function awaitReceipt(
  client: PublicClient,
  hash: Hex,
): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(
      `Router call reverted: tx ${hash}; check block explorer for revert reason.`,
    );
  }
}
