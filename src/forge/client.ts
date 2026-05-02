// client.ts — RezonForge v2.5 write client. Wraps viem's
// writeContract for the agent-facing entry points (sponsor,
// cosponsor, commitSolution, castVote, claim, publishSettlement).
//
// Scope: calldata + broadcast + receipt wait. Intent signing lives
// in src/intents/*; USDC permit signing lives in ./permit.ts. This
// file just takes fully-formed (intent, intentSig, permitV/R/S)
// bundles and broadcasts.
//
// R-CHAIN-VERIFIES-INTENT — RezonForge verifies the signature
// on-chain; the client doesn't re-check.
// R-REUSE-FIRST — viem's writeContract + waitForTransactionReceipt
// handle RPC + nonce + receipt plumbing.

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

import type { CommitIntentMessage } from "../intents/commit-intent.js";
import type { CosponsorIntentMessage } from "../intents/cosponsor-intent.js";
import type { SponsorIntentMessage } from "../intents/sponsor-intent.js";
import type { VoteIntentMessage } from "../intents/vote-intent.js";
import { REZON_FORGE_ABI } from "./abi.js";

/**
 * Permit signature bundle — the USDC EIP-2612 permit that
 * authorizes RezonForge to pull tokens. The contract takes the
 * three components as separate args to match the USDC ABI, which
 * doesn't support a combined 65-byte sig.
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

// ─── sponsor() ─────────────────────────────────────────────────
// First sponsor binds all per-Q parameters.

export interface BroadcastSponsorParams {
  forgeAddress: Address;
  intent: SponsorIntentMessage;
  intentSig: Hex;
  permit: PermitSig;
  /** Gas override. Public Base Sepolia's eth_estimateGas occasionally
   *  returns a value ~10% under actual consumption, causing an
   *  out-of-gas revert. Pass 400_000n to leave headroom. */
  gas?: bigint;
}

export async function broadcastSponsor(
  wallet: WalletClient,
  params: BroadcastSponsorParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: REZON_FORGE_ABI,
    functionName: "sponsor",
    args: [
      {
        questionId: params.intent.questionId,
        oracle: params.intent.oracle,
        token: params.intent.token,
        stakeFloor: params.intent.stakeFloor,
        stakeBasisPoints: params.intent.stakeBasisPoints,
        sponsorshipFloor: params.intent.sponsorshipFloor,
        voteFee: params.intent.voteFee,
        abandonmentGracePeriod: params.intent.abandonmentGracePeriod,
        sponsor: params.intent.sponsor,
        amount: params.intent.amount,
        feeShareBps: params.intent.feeShareBps,
        feeShares: params.intent.feeShares.map((s) => ({
          recipient: s.recipient,
          basisPoints: s.basisPoints,
        })),
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
    ...(params.gas ? { gas: params.gas } : {}),
  });
}

// ─── cosponsor() ───────────────────────────────────────────────
// Subsequent contributor of an OPEN question.

export interface BroadcastCosponsorParams {
  forgeAddress: Address;
  intent: CosponsorIntentMessage;
  intentSig: Hex;
  permit: PermitSig;
  gas?: bigint;
}

export async function broadcastCosponsor(
  wallet: WalletClient,
  params: BroadcastCosponsorParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: REZON_FORGE_ABI,
    functionName: "cosponsor",
    args: [
      {
        questionId: params.intent.questionId,
        sponsor: params.intent.sponsor,
        amount: params.intent.amount,
        feeShareBps: params.intent.feeShareBps,
        feeShares: params.intent.feeShares.map((s) => ({
          recipient: s.recipient,
          basisPoints: s.basisPoints,
        })),
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
    ...(params.gas ? { gas: params.gas } : {}),
  });
}

// ─── commitSolution() ──────────────────────────────────────────

export interface BroadcastCommitParams {
  forgeAddress: Address;
  intent: CommitIntentMessage;
  intentSig: Hex;
  permit: PermitSig;
  gas?: bigint;
}

export async function broadcastCommit(
  wallet: WalletClient,
  params: BroadcastCommitParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: REZON_FORGE_ABI,
    functionName: "commitSolution",
    args: [
      {
        questionId: params.intent.questionId,
        submitter: params.intent.submitter,
        contentHash: params.intent.contentHash,
        feeAmount: params.intent.feeAmount,
        stakeAmount: params.intent.stakeAmount,
        feeShareBps: params.intent.feeShareBps,
        feeShares: params.intent.feeShares.map((s) => ({
          recipient: s.recipient,
          basisPoints: s.basisPoints,
        })),
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
    ...(params.gas ? { gas: params.gas } : {}),
  });
}

// ─── castVote() ────────────────────────────────────────────────

export interface BroadcastVoteParams {
  forgeAddress: Address;
  intent: VoteIntentMessage;
  intentSig: Hex;
  permit: PermitSig;
  gas?: bigint;
}

export async function broadcastVote(
  wallet: WalletClient,
  params: BroadcastVoteParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: REZON_FORGE_ABI,
    functionName: "castVote",
    args: [
      {
        questionId: params.intent.questionId,
        voter: params.intent.voter,
        allocationsHash: params.intent.allocationsHash,
        feeAmount: params.intent.feeAmount,
        stakeAmount: params.intent.stakeAmount,
        feeShareBps: params.intent.feeShareBps,
        feeShares: params.intent.feeShares.map((s) => ({
          recipient: s.recipient,
          basisPoints: s.basisPoints,
        })),
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
    ...(params.gas ? { gas: params.gas } : {}),
  });
}

// ─── claim() ───────────────────────────────────────────────────

export interface BroadcastClaimParams {
  forgeAddress: Address;
  questionId: Hex;
  amount: bigint;
  proof: Hex[];
}

export async function broadcastClaim(
  wallet: WalletClient,
  params: BroadcastClaimParams,
): Promise<Hex> {
  // F21 (mega-audit T2 fence): the contract reverts
  // ForgeZeroClaimAmount when amount == 0. Reject here to skip the
  // wasted broadcast + revert. Validators in this SDK + Solidity
  // guards must agree byte-for-byte; see internal/signer for the
  // backend equivalent.
  if (params.amount <= 0n) {
    throw new Error(
      "claim: amount must be > 0 (chain reverts ForgeZeroClaimAmount per F21)",
    );
  }
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: REZON_FORGE_ABI,
    functionName: "claim",
    args: [params.questionId, params.amount, params.proof],
    account: wallet.account as Account,
    chain: wallet.chain,
  });
}

// ─── publishSettlement() — oracle path ─────────────────────────

export interface BroadcastPublishSettlementParams {
  forgeAddress: Address;
  questionId: Hex;
  merkleRoot: Hex;
  totalClaimable: bigint;
  sampleRecipient: Address;
  sampleAmount: bigint;
  sampleProof: readonly Hex[];
  expiresAt: bigint;
  slashedCommitHashes: readonly Hex[];
  slashedVoteHashes: readonly Hex[];
  oracleSig: Hex;
}

/** Broadcasts `RezonForge.publishSettlement(SettlementIntent intent,
 *  bytes oracleSig)`. Caller must be the oracle address set in
 *  RezonForge's constructor. Slashed stakes move into the pool
 *  atomically with the root commit. The intent struct shape mirrors
 *  RezonForge.SettlementIntent exactly — see abi.ts for the tuple
 *  layout.
 */
export async function broadcastPublishSettlement(
  wallet: WalletClient,
  params: BroadcastPublishSettlementParams,
): Promise<Hex> {
  const intent = {
    questionId: params.questionId,
    merkleRoot: params.merkleRoot,
    totalClaimable: params.totalClaimable,
    sampleRecipient: params.sampleRecipient,
    sampleAmount: params.sampleAmount,
    sampleProof: params.sampleProof as Hex[],
    expiresAt: params.expiresAt,
    slashedCommitHashes: params.slashedCommitHashes as Hex[],
    slashedVoteHashes: params.slashedVoteHashes as Hex[],
  };
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: REZON_FORGE_ABI,
    functionName: "publishSettlement",
    args: [intent, params.oracleSig],
    account: wallet.account as Account,
    chain: wallet.chain,
  });
}

// ─── Receipt wait helper ───────────────────────────────────────

/**
 * Awaits the transaction receipt + asserts `status === "success"`.
 * Throws on revert with the tx hash so the caller can explore
 * the failure on the block explorer.
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
