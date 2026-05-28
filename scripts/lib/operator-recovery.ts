// operator-recovery.ts — shared Quadphase v2 money-out helpers for the
// operator fund-recovery scripts (settle-and-claim, sweep-recoverable,
// recover-claim-sweep, claim-sweep).
//
// v1 → v2 shift. The v1 scripts each re-derived the Merkle tree / proofs
// client-side and broadcast the removed per-action functions
// (claim / claimAllForQuestion / sponsorRefund / commitRefund /
// voteRefund). In v2 the chain exposes only `pullValue(env,sig,witness)`
// for both claim and refund, and the canonical source of proofs + amounts
// + nonces is the backend's unified money-out door:
//
//   POST /v1/questions/:id/intents/preflight  {actionType:"withdraw"}
//        → WithdrawDraftResponse { eligible: WithdrawItem[] }
//
// One preflight per (signer, question) returns EVERY intent the signer is
// owed — the winner-payout CLAIM plus each unrefunded sponsor / commit-
// stake / vote-fee REFUND — already shaped, nonce-allocated, and hash-
// pinned. This module signs + broadcasts each via runClaimFlow /
// runRefundFlow (→ pullValue), mirroring the live MCP `withdraw` tool
// (mcp-servers/protocol-api/server.ts) so the operator scripts and the
// agent path share one money-out code path.
//
// R-CLIENT-IS-TRUST-ORIGIN — the backend door returns the canonical
// envelope template + expectedIntentHash; the client signs it verbatim.
// R-INTENT-HASH-IS-MATCH-KEY — runClaimFlow / runRefundFlow recompute the
// EIP-712 struct hash locally and assert it == the draft's
// expectedIntentHash before signing; drift is fatal there.

import type { Address, Hex, PublicClient } from "viem";
import { createPublicClient, http } from "viem";

import { deriveAgentWallet } from "../../src/wallet/derive.js";
import { loadLoginDomain } from "../../src/wallet/domain.js";
import { SessionManager } from "../../src/wallet/session.js";
import {
  awaitReceipt,
  makeAgentWalletClient,
} from "../../src/forge/quadphase-broadcast.js";
import {
  runClaimFlow,
  runRefundFlow,
} from "../../src/forge/quadphase-flow.js";
import type {
  ClaimDraftResponse,
  RefundDraftResponse,
  WithdrawDraftResponse,
  WithdrawItem,
} from "../../src/intents/preflight-types.js";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export interface DerivedWallet {
  index: number;
  address: Address;
  privateKey: Hex;
}

/** Derive idx 0..size-1 from the mnemonic, keyed by lowercase address.
 *  Uses the same BIP-44 path (m/44'/60'/0'/0/<idx>) as the rest of the
 *  fleet tooling via deriveAgentWallet. */
export function buildWalletBank(
  mnemonic: string,
  size: number,
  chainId: number,
): Map<string, DerivedWallet> {
  const bank = new Map<string, DerivedWallet>();
  for (let i = 0; i < size; i++) {
    const w = deriveAgentWallet(mnemonic, i, chainId);
    bank.set(w.address.toLowerCase(), {
      index: i,
      address: w.address as Address,
      privateKey: w.privateKey as Hex,
    });
  }
  return bank;
}

// Process-wide session cache so repeated loginWallet() calls for the same
// wallet reuse one JWT (P0: login once, reuse across actions). Keyed by
// apiBase since one process may target multiple backends in a test.
const sessionManagers = new Map<string, SessionManager>();
function sessionManagerFor(apiBase: string): SessionManager {
  const base = apiBase.replace(/\/$/, "");
  let mgr = sessionManagers.get(base);
  if (!mgr) {
    mgr = new SessionManager({ apiBase: base, domain: loadLoginDomain() });
    sessionManagers.set(base, mgr);
  }
  return mgr;
}

/** Sign a WalletLoginIntent for the given HD index and exchange it for a
 *  backend JWT via POST /v1/sessions. The withdraw door is Bearer-gated
 *  (the eligible set is scoped to the JWT-bound wallet). Routes through a
 *  process-wide SessionManager — the first call per wallet logs in; later
 *  calls reuse the cached token (collapsing the per-question login fan-out). */
export async function loginWallet(
  apiBase: string,
  mnemonic: string,
  walletIdx: number,
): Promise<{ bearer: string; address: Address; privateKey: Hex }> {
  const domain = loadLoginDomain();
  const wallet = deriveAgentWallet(mnemonic, walletIdx, domain.chainId);
  const bearer = await sessionManagerFor(apiBase).ensureToken(wallet);
  return {
    bearer,
    address: wallet.address as Address,
    privateKey: wallet.privateKey as Hex,
  };
}

/** Fetch the withdraw-door draft (every claim/refund the signer is owed
 *  on the question). Empty `eligible` is a valid 200 — the signer is owed
 *  nothing here, not an error. */
export async function fetchWithdrawDraft(
  apiBase: string,
  bearer: string,
  questionId: string,
  signer: Address,
): Promise<WithdrawDraftResponse> {
  const res = await fetch(
    `${apiBase}/v1/questions/${questionId}/intents/preflight`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        actionType: "withdraw",
        params: { signer },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `withdraw preflight (${questionId}) failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as WithdrawDraftResponse;
}

/** Pull the bounty token off a draft's nested envelope template. The
 *  withdraw drafts carry the token at envelopeTemplate.envelope.funds.token
 *  (no top-level token field). Throws if absent/malformed so we never sign
 *  an envelope with a zero/garbage token (which reverts the funds-shape
 *  gate on-chain). Mirrors server.ts::tokenFromTemplate. */
export function tokenFromTemplate(
  tmpl: ClaimDraftResponse | RefundDraftResponse | null | undefined,
  kind: "claim" | "refund",
): Address {
  const env = tmpl?.envelopeTemplate?.envelope as
    | { funds?: { token?: unknown } }
    | undefined;
  const token = env?.funds?.token;
  if (typeof token !== "string" || !ADDR_RE.test(token) || token.toLowerCase() === ZERO_ADDR) {
    throw new Error(
      `withdraw ${kind} draft has no usable envelopeTemplate.envelope.funds.token (got ${JSON.stringify(token)})`,
    );
  }
  return token as Address;
}

/** Pull expectedStatus out of a claim draft's witness (the backend bakes
 *  onchainStatusSettled=3 into the ClaimWitness). Defaults to Settled=3 if
 *  the template omits it. Mirrors server.ts::claimExpectedStatus. */
export function claimExpectedStatus(claim: ClaimDraftResponse): number {
  const w = claim.envelopeTemplate?.witness as
    | { expectedStatus?: unknown }
    | undefined;
  return typeof w?.expectedStatus === "number" ? w.expectedStatus : 3;
}

export interface WithdrawnItemResult {
  actionType: "claim" | "refund";
  role: string;
  status: "broadcast" | "failed";
  intentHash?: Hex;
  txHash?: Hex;
  /** Amount actually pulled (0 on a failed broadcast). */
  amountWei: bigint;
  /** Amount the withdraw door said was OWED for this item, taken from
   *  the preflight draft (leafAmount / expectedAmount). Populated even
   *  when the broadcast fails, so a finance audit can distinguish
   *  "owed-but-not-yet-pulled" (timing) from a genuine shortfall. */
  owedWei: bigint;
  error?: string;
}

export interface SweepWalletResult {
  address: Address;
  index: number;
  questionId: string;
  eligibleCount: number;
  items: WithdrawnItemResult[];
  totalWithdrawnWei: bigint;
  failures: number;
}

export interface SweepOptions {
  apiBase: string;
  forgeAddress: Address;
  rpcUrl: string;
  chainId: number;
  /** When true, log intended actions without signing or broadcasting. */
  dryRun: boolean;
}

/**
 * Withdraw every eligible claim + refund for an already-authenticated
 * wallet on one question. This is the canonical sweep primitive the
 * scripts call (they log in once per wallet via loginWallet, then sweep
 * each question). Per-item resilient: one item failing does not abort the
 * rest. Mirrors the MCP `withdraw` tool's per-item loop but operates on a
 * known private key (operator/fleet wallet) rather than a derived agent
 * wallet.
 */
export async function sweepWalletQuestion(
  opts: SweepOptions,
  wallet: DerivedWallet,
  bearer: string,
  questionId: string,
): Promise<SweepWalletResult> {
  const draft = await fetchWithdrawDraft(
    opts.apiBase,
    bearer,
    questionId,
    wallet.address,
  );
  const items = draft.eligible ?? [];
  const result: SweepWalletResult = {
    address: wallet.address,
    index: wallet.index,
    questionId,
    eligibleCount: items.length,
    items: [],
    totalWithdrawnWei: 0n,
    failures: 0,
  };
  if (items.length === 0) return result;

  const walletClient = opts.dryRun
    ? null
    : makeAgentWalletClient({
        privateKey: wallet.privateKey,
        chainId: opts.chainId,
        rpcUrl: opts.rpcUrl,
      });
  // Separate public client for receipt polling — viem's WalletClient
  // doesn't carry the public action set. HTTP-only transport is all
  // waitForTransactionReceipt needs.
  const publicClient: PublicClient | null = opts.dryRun
    ? null
    : (createPublicClient({ transport: http(opts.rpcUrl) }) as PublicClient);

  for (const item of items as WithdrawItem[]) {
    // Owed amount from the draft (independent of broadcast success), so a
    // failed pull still reports what the door said was owed.
    const owedWei =
      item.actionType === "claim" && item.claim
        ? BigInt(item.claim.leafAmount)
        : item.actionType === "refund" && item.refund
          ? BigInt(item.refund.expectedAmount)
          : 0n;
    try {
      if (item.actionType === "claim" && item.claim) {
        const c = item.claim;
        const amount = BigInt(c.leafAmount);
        if (opts.dryRun) {
          result.items.push({
            actionType: "claim",
            role: item.role,
            status: "broadcast",
            amountWei: amount,
            owedWei,
          });
          result.totalWithdrawnWei += amount;
          continue;
        }
        const token = tokenFromTemplate(c, "claim");
        const flow = await runClaimFlow({
          signer: wallet.address,
          qid: c.qid as Hex,
          questionId,
          nonce: BigInt(c.nonce),
          expiresAt: BigInt(c.recommendedExpiresAt),
          forgeAddress: opts.forgeAddress,
          chainId: c.chainId ?? opts.chainId,
          token,
          proof: c.proof as Hex[],
          leafIndex: BigInt(c.leafIndex),
          leafAmount: amount,
          role: c.role,
          expectedStatus: claimExpectedStatus(c),
          bearerToken: bearer,
          baseUrl: opts.apiBase,
          expectedIntentHash: c.expectedIntentHash as Hex,
          walletClient: walletClient!,
          privateKey: wallet.privateKey,
        });
        await awaitReceipt(publicClient!, flow.txHash!);
        result.totalWithdrawnWei += amount;
        result.items.push({
          actionType: "claim",
          role: item.role,
          status: "broadcast",
          intentHash: flow.intentHash,
          txHash: flow.txHash,
          amountWei: amount,
          owedWei,
        });
      } else if (item.actionType === "refund" && item.refund) {
        const r = item.refund;
        const amount = BigInt(r.expectedAmount);
        if (opts.dryRun) {
          result.items.push({
            actionType: "refund",
            role: item.role,
            status: "broadcast",
            amountWei: amount,
            owedWei,
          });
          result.totalWithdrawnWei += amount;
          continue;
        }
        const token = tokenFromTemplate(r, "refund");
        const flow = await runRefundFlow({
          signer: wallet.address,
          qid: r.qid as Hex,
          questionId,
          nonce: BigInt(r.nonce),
          expiresAt: BigInt(r.recommendedExpiresAt),
          forgeAddress: opts.forgeAddress,
          chainId: r.chainId ?? opts.chainId,
          token,
          sourceIntentHash: r.sourceIntentHash as Hex,
          expectedAmount: amount,
          expectedStatus: r.expectedStatus,
          bearerToken: bearer,
          baseUrl: opts.apiBase,
          expectedIntentHash: r.expectedIntentHash as Hex,
          walletClient: walletClient!,
          privateKey: wallet.privateKey,
        });
        await awaitReceipt(publicClient!, flow.txHash!);
        result.totalWithdrawnWei += amount;
        result.items.push({
          actionType: "refund",
          role: item.role,
          status: "broadcast",
          intentHash: flow.intentHash,
          txHash: flow.txHash,
          amountWei: amount,
          owedWei,
        });
      } else {
        // Malformed item — neither leg populated. Record + continue.
        result.failures++;
        result.items.push({
          actionType: item.actionType,
          role: item.role,
          status: "failed",
          amountWei: 0n,
          owedWei,
          error: "draft item has no usable claim/refund payload",
        });
      }
    } catch (err) {
      result.failures++;
      result.items.push({
        actionType: item.actionType,
        role: item.role,
        status: "failed",
        amountWei: 0n,
        owedWei,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
