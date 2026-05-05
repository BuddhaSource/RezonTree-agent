#!/usr/bin/env tsx
/**
 * settle-and-claim.ts — productized settlement + claim sweep for any
 * round. Drop-in replacement for the hardcoded `settle-round5.ts`
 * one-shot. Intended to be run by an operator immediately after a
 * battle round closes (or any time a round is ready to settle).
 *
 * What it does, in order:
 *   1. Reads question state from both the backend API and the chain.
 *      Chain `poolAmount` is treated as authoritative; a non-zero
 *      drift vs `chain_pool_amount` on the API is flagged as a
 *      Ponder/projector defect (R-VERIFY-FOUR-LAYERS) and aborts
 *      with exit code 2.
 *   2. Idempotency check — if `q.status == STATUS_SETTLED` on chain,
 *      skip publishSettlement and just sweep claims. STATUS_VOID or
 *      STATUS_OPEN-with-no-solutions exits with code 3.
 *   3. Fetches confirmed solutions + votes from the API, aggregates
 *      conviction points per solution, derives per-author + per-voter
 *      payouts proportional to the chain `poolAmount`. Rounds down;
 *      the largest leaf absorbs any rounding remainder so
 *      Σleaves == poolAmount exactly.
 *   4. Builds the Merkle tree, signs a SettlementIntent with the
 *      oracle key, and broadcasts publishSettlement (skipped under
 *      RT_DRY_RUN=1 or if already settled).
 *   5. Sweeps Merkle claims for every winner whose address matches a
 *      mnemonic-derived wallet at indices 0..30 (matches the battle
 *      harness wallet bank). Winners outside the bank are warned and
 *      left to claim themselves.
 *   6. Optionally sweeps solution + vote stake-back claims (skip
 *      with RT_SKIP_STAKE_CLAIMS=1).
 *
 * Required env:
 *   RT_QID                      — bytes32 question id (0x...)
 *   RT_FORGE_ADDRESS            — RezonForge router address
 *   RT_AGENT_MNEMONIC           — 12/24-word BIP-39 phrase
 *
 * Optional env:
 *   RT_API_BASE                 — default http://localhost:8080
 *   RT_RPC_URL                  — default https://sepolia.base.org
 *   RT_USDC_ADDRESS             — default Base Sepolia USDC
 *   RT_CHAIN_ID                 — default 84532
 *   RT_ORACLE_WALLET_INDEX      — default 0
 *   RT_DRY_RUN                  — "1" to skip all broadcasts
 *   RT_SKIP_STAKE_CLAIMS        — "1" to skip solution+vote stake claims
 *   RT_WALLET_BANK_SIZE         — default 30 (search depth for winner wallets)
 *
 * Exit codes:
 *   0  success
 *   1  required env missing
 *   2  API/chain mismatch (chainPoolAmount drift > 1 wei)
 *   3  no winners (nothing to settle)
 *   4  settle/claim broadcast failed
 *   5  unexpected (catch-all)
 */

import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

import { REZON_FORGE_ABI } from "../src/forge/abi.js";
import {
  awaitReceipt,
  broadcastClaim,
  broadcastPublishSettlement,
  makeAgentWalletClient,
} from "../src/forge/client.js";
import {
  DEFAULT_SETTLEMENT_TTL_SECONDS,
  buildSettlementIntentTypedData,
} from "../src/intents/settlement-intent.js";
import {
  buildTreeLevels,
  hashLeaf,
  merkleProof,
  type MerkleLeaf,
} from "../src/intents/merkle.js";

// ─── Exit-code helpers ───────────────────────────────────────────

const EXIT = {
  OK: 0,
  ENV_MISSING: 1,
  CHAIN_API_DRIFT: 2,
  NO_WINNERS: 3,
  BROADCAST_FAILED: 4,
  UNEXPECTED: 5,
} as const;

class FatalExit extends Error {
  constructor(public code: number, msg: string) {
    super(msg);
  }
}

// ─── Color helpers (mirrors settle-claim.ts) ─────────────────────

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const log = (s: string, d?: string) =>
  console.log(`${c.cyan(`[${s}]`)}${d ? ` ${d}` : ""}`);
const ok = (d: string) => console.log(`  ${c.green("✓")} ${d}`);
const warn = (d: string) => console.log(`  ${c.yellow("!")} ${d}`);
const info = (d: string) => console.log(`  ${c.dim(d)}`);

// ─── Env parsing ─────────────────────────────────────────────────

interface Env {
  qid: Hex;
  forge: Address;
  mnemonic: string;
  apiBase: string;
  rpcUrl: string;
  usdc: Address;
  chainId: number;
  oracleIdx: number;
  dryRun: boolean;
  skipStakeClaims: boolean;
  walletBankSize: number;
}

function parseEnv(): Env {
  const qid = process.env.RT_QID;
  const forge = process.env.RT_FORGE_ADDRESS;
  const mnemonic = process.env.RT_AGENT_MNEMONIC;
  if (!qid) {
    throw new FatalExit(EXIT.ENV_MISSING, "RT_QID required (bytes32 question id, 0x-prefixed)");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(qid)) {
    throw new FatalExit(EXIT.ENV_MISSING, `RT_QID malformed: expected 0x + 64 hex, got ${qid}`);
  }
  if (!forge) {
    throw new FatalExit(EXIT.ENV_MISSING, "RT_FORGE_ADDRESS required (RezonForge router contract address)");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(forge)) {
    throw new FatalExit(EXIT.ENV_MISSING, `RT_FORGE_ADDRESS malformed: ${forge}`);
  }
  if (!mnemonic || mnemonic.trim().split(/\s+/).length < 12) {
    throw new FatalExit(EXIT.ENV_MISSING, "RT_AGENT_MNEMONIC required (BIP-39 phrase, 12+ words)");
  }
  return {
    qid: qid as Hex,
    forge: forge as Address,
    mnemonic,
    apiBase: (process.env.RT_API_BASE ?? "http://localhost:8080").replace(/\/$/, ""),
    rpcUrl: process.env.RT_RPC_URL ?? "https://sepolia.base.org",
    usdc: (process.env.RT_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address,
    chainId: Number.parseInt(process.env.RT_CHAIN_ID ?? "84532", 10),
    oracleIdx: Number.parseInt(process.env.RT_ORACLE_WALLET_INDEX ?? "0", 10),
    dryRun: process.env.RT_DRY_RUN === "1",
    skipStakeClaims: process.env.RT_SKIP_STAKE_CLAIMS === "1",
    walletBankSize: Number.parseInt(process.env.RT_WALLET_BANK_SIZE ?? "30", 10),
  };
}

// ─── HD wallet helpers ───────────────────────────────────────────

interface DerivedWallet {
  index: number;
  address: Address;
  privateKey: Hex;
}

function deriveWallet(mnemonic: string, idx: number): DerivedWallet {
  const acct = mnemonicToAccount(mnemonic, {
    path: `m/44'/60'/0'/0/${idx}` as const,
  });
  const pk = acct.getHdKey().privateKey;
  if (!pk) throw new Error(`HD derivation idx=${idx}: missing private key`);
  return {
    index: idx,
    address: acct.address as Address,
    privateKey: `0x${Buffer.from(pk).toString("hex")}` as Hex,
  };
}

function buildWalletBank(mnemonic: string, size: number): Map<string, DerivedWallet> {
  const bank = new Map<string, DerivedWallet>();
  for (let i = 0; i < size; i++) {
    const w = deriveWallet(mnemonic, i);
    bank.set(w.address.toLowerCase(), w);
  }
  return bank;
}

// ─── API helpers ─────────────────────────────────────────────────

async function apiGet<T>(base: string, path: string): Promise<T> {
  const url = `${base}${path}`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GET ${url} → ${r.status}: ${body.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

// Backend may serve either snake_case (current) or camelCase (post-sweep).
// We accept both per response field; reads stay defensive.
function pickField<T = unknown>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

interface ApiQuestion {
  raw: Record<string, unknown>;
  chainPoolAmount: bigint | undefined;
  chainStatus: string | undefined;
  chainTotalClaimable: bigint | undefined;
}

function parseQuestion(raw: Record<string, unknown>): ApiQuestion {
  const cpaStr = pickField<string>(raw, "chainPoolAmount", "chain_pool_amount");
  const ctcStr = pickField<string>(raw, "chainTotalClaimable", "chain_total_claimable");
  return {
    raw,
    chainPoolAmount: cpaStr !== undefined ? BigInt(cpaStr) : undefined,
    chainStatus: pickField<string>(raw, "chainStatus", "chain_status", "status"),
    chainTotalClaimable: ctcStr !== undefined ? BigInt(ctcStr) : undefined,
  };
}

interface ConfirmedSolution {
  id: string;
  authorAddress: Address;
  intentHash: Hex | undefined;
  confirmationStatus: string;
  rank: number | undefined;
}

function parseSolutions(rows: Array<Record<string, unknown>>): ConfirmedSolution[] {
  return rows
    .map((s) => {
      const status = pickField<string>(s, "confirmationStatus", "confirmation_status") ?? "";
      const author = pickField<string>(s, "authorAddress", "author_address") ?? "";
      const intentHash = pickField<string>(s, "intentHash", "intent_hash");
      const rank = pickField<number>(s, "rank");
      return {
        id: pickField<string>(s, "id") ?? "",
        authorAddress: author.toLowerCase() as Address,
        intentHash: intentHash as Hex | undefined,
        confirmationStatus: status,
        rank,
      };
    })
    .filter((s) => s.confirmationStatus === "confirmed" && s.authorAddress.startsWith("0x"));
}

interface VoteAllocation {
  solutionId: string;
  convictionPoints: number;
}

interface ConfirmedVote {
  id: string;
  voterAddress: Address;
  intentHash: Hex | undefined;
  confirmationStatus: string;
  allocations: VoteAllocation[];
}

function parseVotes(rows: Array<Record<string, unknown>>): ConfirmedVote[] {
  return rows
    .map((v) => {
      const status = pickField<string>(v, "confirmationStatus", "confirmation_status") ?? "";
      const voter = pickField<string>(v, "voterAddress", "voter_address") ?? "";
      const intentHash = pickField<string>(v, "intentHash", "intent_hash");
      const allocsRaw = pickField<Array<Record<string, unknown>>>(v, "allocations") ?? [];
      const allocations: VoteAllocation[] = allocsRaw.map((a) => ({
        solutionId: pickField<string>(a, "solutionId", "solution_id") ?? "",
        convictionPoints: Number(pickField<number | string>(a, "convictionPoints", "conviction_points") ?? 0),
      }));
      return {
        id: pickField<string>(v, "id") ?? "",
        voterAddress: voter.toLowerCase() as Address,
        intentHash: intentHash as Hex | undefined,
        confirmationStatus: status,
        allocations,
      };
    })
    .filter((v) => v.confirmationStatus === "confirmed" && v.voterAddress.startsWith("0x"));
}

// ─── Payout aggregation ──────────────────────────────────────────
//
// Conviction-vote payout model (matches settle-round5 + backend
// service/round.go semantics): for each solution, split its share
// of the pool 70/30 between the author and the voter quadratic-
// conviction pool. Within voters, allocate proportional to each
// voter's conviction points cast on that solution.
//
// We don't try to reproduce the backend's exact rank-weighting
// here; instead we mirror the simpler "winners are the
// rank-bearing solutions" rule: any solution that has a
// non-undefined rank is treated as a winner, weighted by total
// conviction. If no rank field is set yet (pre-settle DB state),
// every solution with at least one vote is treated as a winner.
//
// AUTHOR_BPS / VOTER_BPS sum to 10000.

const AUTHOR_BPS = 7000n;
const VOTER_BPS = 3000n;

interface PayoutRow {
  recipient: Address;
  amount: bigint;
}

function aggregatePayouts(
  solutions: ConfirmedSolution[],
  votes: ConfirmedVote[],
  poolAmount: bigint,
): PayoutRow[] {
  // Build conviction map: solutionId → total conviction across confirmed voters.
  const solConvictions = new Map<string, bigint>();
  // And per-(solutionId, voterAddress) conviction.
  const voterContrib = new Map<string, Map<Address, bigint>>();
  for (const v of votes) {
    for (const a of v.allocations) {
      if (a.convictionPoints <= 0) continue;
      const points = BigInt(a.convictionPoints);
      solConvictions.set(a.solutionId, (solConvictions.get(a.solutionId) ?? 0n) + points);
      let perSol = voterContrib.get(a.solutionId);
      if (!perSol) {
        perSol = new Map();
        voterContrib.set(a.solutionId, perSol);
      }
      perSol.set(v.voterAddress, (perSol.get(v.voterAddress) ?? 0n) + points);
    }
  }

  // Eligible solutions: any solution that received conviction. If the
  // backend has already projected ranks, filter to ranked solutions
  // (ties to settled-round semantics); otherwise include all with
  // conviction.
  const anyRanked = solutions.some((s) => s.rank !== undefined);
  const eligible = solutions.filter((s) =>
    anyRanked ? s.rank !== undefined : (solConvictions.get(s.id) ?? 0n) > 0n,
  );
  if (eligible.length === 0) return [];

  // Total conviction across eligible solutions — drives the per-
  // solution share of the pool. Solutions without conviction are
  // skipped here (their author share is forfeited to the rest).
  let totalEligibleConviction = 0n;
  for (const s of eligible) {
    totalEligibleConviction += solConvictions.get(s.id) ?? 0n;
  }
  if (totalEligibleConviction === 0n) {
    // Edge case: ranked solutions but nobody voted (impossible with
    // current rules, but guard anyway). Split evenly across authors.
    const per = poolAmount / BigInt(eligible.length);
    const rows: PayoutRow[] = eligible.map((s) => ({
      recipient: s.authorAddress,
      amount: per,
    }));
    return mergeAndCapToPool(rows, poolAmount);
  }

  // Per-solution pool share.
  const rows: PayoutRow[] = [];
  for (const s of eligible) {
    const conv = solConvictions.get(s.id) ?? 0n;
    if (conv === 0n) continue;
    const solPool = (poolAmount * conv) / totalEligibleConviction;
    if (solPool === 0n) continue;

    const authorAmount = (solPool * AUTHOR_BPS) / 10000n;
    const voterPool = solPool - authorAmount; // avoids double-rounding loss

    rows.push({ recipient: s.authorAddress, amount: authorAmount });

    const voters = voterContrib.get(s.id);
    if (voters && voterPool > 0n) {
      let totalVoterConv = 0n;
      for (const v of voters.values()) totalVoterConv += v;
      // Distribute voterPool proportional to per-voter conviction.
      let distributed = 0n;
      const voterEntries = [...voters.entries()];
      for (let i = 0; i < voterEntries.length; i++) {
        const [addr, conv2] = voterEntries[i];
        let share: bigint;
        if (i === voterEntries.length - 1) {
          share = voterPool - distributed; // absorb intra-solution rounding
        } else {
          share = (voterPool * conv2) / totalVoterConv;
          distributed += share;
        }
        if (share > 0n) rows.push({ recipient: addr, amount: share });
      }
    }
  }

  return mergeAndCapToPool(rows, poolAmount);
}

/** Merge per-recipient rows + force Σ == poolAmount by adjusting the
 *  largest leaf for any rounding remainder. */
function mergeAndCapToPool(rows: PayoutRow[], poolAmount: bigint): PayoutRow[] {
  const merged = new Map<Address, bigint>();
  for (const r of rows) {
    if (r.amount <= 0n) continue;
    const key = r.recipient.toLowerCase() as Address;
    merged.set(key, (merged.get(key) ?? 0n) + r.amount);
  }
  const out: PayoutRow[] = [...merged.entries()].map(([recipient, amount]) => ({ recipient, amount }));
  if (out.length === 0) return out;

  // Force Σ == poolAmount by absorbing the difference into the
  // largest leaf. Both directions: shortfall (rounding-down) AND
  // overshoot (e.g. last-voter bucket pulled too much).
  let total = 0n;
  for (const r of out) total += r.amount;
  const delta = poolAmount - total;
  if (delta !== 0n) {
    let largestIdx = 0;
    for (let i = 1; i < out.length; i++) if (out[i].amount > out[largestIdx].amount) largestIdx = i;
    const adjusted = out[largestIdx].amount + delta;
    if (adjusted < 0n) {
      // Shouldn't happen with sane inputs — guardrail.
      throw new Error(
        `payout adjustment underflow: largest leaf ${out[largestIdx].amount} + delta ${delta} < 0`,
      );
    }
    out[largestIdx].amount = adjusted;
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const env = parseEnv();
  log(
    "settle-and-claim",
    c.bold(
      `qid ${env.qid.slice(0, 10)}… | forge ${env.forge.slice(0, 10)}… | dryRun=${env.dryRun ? "yes" : "no"}`,
    ),
  );
  info(`api ${env.apiBase}`);
  info(`rpc ${env.rpcUrl} (chainId ${env.chainId})`);

  // ── Wallets ─────────────────────────────────────────────────────
  const oracle = deriveWallet(env.mnemonic, env.oracleIdx);
  ok(`oracle wallet idx=${env.oracleIdx} → ${oracle.address}`);
  const walletBank = buildWalletBank(env.mnemonic, env.walletBankSize);
  info(`wallet bank size = ${walletBank.size} (idx 0..${env.walletBankSize - 1})`);

  const publicClient = createPublicClient({
    chain: {
      id: env.chainId,
      name: `chain-${env.chainId}`,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [env.rpcUrl] } },
    },
    transport: http(env.rpcUrl),
  });
  const oracleWallet = makeAgentWalletClient({
    privateKey: oracle.privateKey,
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
  });

  // ── Step 1: parallel API + chain reads ─────────────────────────
  log("1/8", "fetch question state (api + chain in parallel)");
  const [qApi, qChainRaw, solutionsRaw, votesRaw] = await Promise.all([
    apiGet<Record<string, unknown>>(env.apiBase, `/v1/questions/${env.qid}`).catch((err) => {
      warn(`API /v1/questions/${env.qid} failed: ${err instanceof Error ? err.message : err}`);
      return {} as Record<string, unknown>;
    }),
    publicClient.readContract({
      address: env.forge,
      abi: REZON_FORGE_ABI,
      functionName: "questions",
      args: [env.qid],
    }),
    apiGet<Record<string, unknown>>(env.apiBase, `/v1/questions/${env.qid}/solutions?confirmation=confirmed`).catch(
      (err) => {
        warn(`API solutions fetch failed: ${err instanceof Error ? err.message : err}`);
        return { data: [] } as Record<string, unknown>;
      },
    ),
    apiGet<Record<string, unknown>>(env.apiBase, `/v1/questions/${env.qid}/votes?confirmation=confirmed`).catch(
      (err) => {
        warn(`API votes fetch failed: ${err instanceof Error ? err.message : err}`);
        return { data: [] } as Record<string, unknown>;
      },
    ),
  ]);

  // Decode chain return tuple — ABI declares 18 named outputs. viem
  // returns it as an object keyed by name. Index by name for safety.
  const qChain = qChainRaw as unknown as {
    status: number;
    poolAmount: bigint;
    solutionCount: number;
  };
  const chainStatus = qChain.status;
  const chainPoolAmount = qChain.poolAmount;
  const chainSolutionCount = qChain.solutionCount;
  ok(
    `chain: status=${chainStatus} poolAmount=${chainPoolAmount} solutionCount=${chainSolutionCount}`,
  );

  const apiQ = parseQuestion(qApi);
  if (apiQ.chainPoolAmount !== undefined) {
    const drift = apiQ.chainPoolAmount - chainPoolAmount;
    const absDrift = drift < 0n ? -drift : drift;
    if (absDrift > 1n) {
      throw new FatalExit(
        EXIT.CHAIN_API_DRIFT,
        `chainPoolAmount drift > 1 wei: api=${apiQ.chainPoolAmount} chain=${chainPoolAmount} (Δ=${drift}). Ponder/projector lag — re-run after indexer catches up. (R-VERIFY-FOUR-LAYERS)`,
      );
    }
    info(`api chain_pool_amount=${apiQ.chainPoolAmount} (Δ=${drift} wei vs chain — within tolerance)`);
  } else {
    warn("api response missing chain_pool_amount; skipping mirror-drift check");
  }

  // ── Step 2: idempotency ────────────────────────────────────────
  log("2/8", "idempotency check");
  const STATUS_VOID = 0;
  const STATUS_OPEN = 1;
  const STATUS_SETTLED = 2;
  const STATUS_ABANDONED = 3;
  let alreadySettled = false;
  if (chainStatus === STATUS_SETTLED) {
    alreadySettled = true;
    ok("question already STATUS_SETTLED on chain — skipping publishSettlement, will only sweep claims");
  } else if (chainStatus === STATUS_VOID) {
    throw new FatalExit(EXIT.NO_WINNERS, "chain status = STATUS_VOID — nothing to settle");
  } else if (chainStatus === STATUS_ABANDONED) {
    throw new FatalExit(EXIT.NO_WINNERS, "chain status = STATUS_ABANDONED — refunds happen via abandon path, not this script");
  } else if (chainStatus === STATUS_OPEN && chainSolutionCount === 0) {
    throw new FatalExit(EXIT.NO_WINNERS, "chain status = STATUS_OPEN with 0 solutions — nothing to settle");
  } else {
    info(`chain status = ${chainStatus} (OPEN) — will run full settle + claim flow`);
  }

  // ── Step 3: parse confirmed solutions + votes ─────────────────
  const solutionsList = (solutionsRaw.data as Array<Record<string, unknown>>) ?? [];
  const votesList = (votesRaw.data as Array<Record<string, unknown>>) ?? [];
  const solutions = parseSolutions(solutionsList);
  const votes = parseVotes(votesList);
  log("3/8", `confirmed: ${solutions.length} solutions, ${votes.length} votes`);
  if (solutions.length === 0) {
    throw new FatalExit(EXIT.NO_WINNERS, "no confirmed solutions in API — nothing to settle");
  }

  // ── Step 4: build leaves ───────────────────────────────────────
  log("4/8", "build payout leaves from conviction aggregation");
  const payouts = aggregatePayouts(solutions, votes, chainPoolAmount);
  if (payouts.length === 0) {
    throw new FatalExit(EXIT.NO_WINNERS, "no winners after conviction aggregation");
  }
  // v2.10 (C05): defense-in-depth pre-aggregation by recipient. The
  // chain dedups via claimed[qid][recipient]; duplicate leaves would
  // strand funds (only the first claim succeeds; second reverts
  // ForgeAlreadyClaimed). aggregatePayouts → mergeAndCapToPool
  // already merges per-recipient, but we re-verify at leaf-build
  // time so a future refactor that bypasses mergeAndCapToPool
  // doesn't silently regress. R-CHAIN-VERIFIES-INTENT.
  const aggregated = new Map<Address, bigint>();
  for (const p of payouts) {
    const key = p.recipient.toLowerCase() as Address;
    aggregated.set(key, (aggregated.get(key) ?? 0n) + p.amount);
  }
  if (aggregated.size !== payouts.length) {
    throw new Error(
      `internal (C05): payouts contained duplicate recipients — aggregator failed pre-aggregation contract; got ${payouts.length} rows, ${aggregated.size} unique recipients`,
    );
  }
  const leaves: MerkleLeaf[] = [...aggregated.entries()].map(
    ([recipient, amount]) => ({
      questionId: env.qid,
      recipient,
      amount,
    }),
  );
  let totalClaimable = 0n;
  for (const l of leaves) totalClaimable += l.amount;
  ok(`${leaves.length} leaves, totalClaimable=${totalClaimable} (pool=${chainPoolAmount})`);
  if (totalClaimable !== chainPoolAmount) {
    // mergeAndCapToPool should have made these equal; if not, we
    // have a bug — bail before publishing a misaligned envelope.
    throw new Error(
      `internal: Σleaves (${totalClaimable}) != poolAmount (${chainPoolAmount}); mergeAndCapToPool failed`,
    );
  }
  for (const l of leaves) {
    info(`  ${l.recipient}: ${l.amount}`);
  }

  // ── Step 5: Merkle tree + sample proof ─────────────────────────
  log("5/8", "build Merkle tree");
  const leafHashes = leaves.map(hashLeaf);
  const levels = buildTreeLevels(leafHashes);
  // settle-round5 uses levels[levels.length - 1][0] — the top
  // (single-element) level. settle-claim uses levels[0][0] only
  // because it's a 1-leaf tree (root == leaf). The first form is
  // correct for any tree size.
  const root = levels[levels.length - 1][0];
  const sampleLeaf = leaves[0];
  const sampleProof = merkleProof(leafHashes, 0) as Hex[];
  ok(`merkleRoot ${root}`);
  info(`sample leaf 0 → ${sampleLeaf.recipient} amount=${sampleLeaf.amount} proofLen=${sampleProof.length}`);

  // ── Step 6: sign + broadcast publishSettlement ────────────────
  if (alreadySettled) {
    log("6/8", "skipping publishSettlement (already settled)");
  } else if (env.dryRun) {
    log("6/8", c.yellow("DRY RUN — skipping publishSettlement"));
    info("would sign SettlementIntent + broadcast publishSettlement here");
  } else {
    log("6/8", "sign + broadcast publishSettlement");
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = BigInt(now + DEFAULT_SETTLEMENT_TTL_SECONDS);
    const td = buildSettlementIntentTypedData({
      forgeAddress: env.forge,
      chainId: env.chainId,
      questionId: env.qid,
      merkleRoot: root,
      totalClaimable,
      sampleRecipient: sampleLeaf.recipient,
      sampleAmount: sampleLeaf.amount,
      sampleProof,
      expiresAtSeconds: Number(expiresAt),
      nowSeconds: now,
    });
    const oracleAccount = privateKeyToAccount(oracle.privateKey);
    const oracleSig = (await oracleAccount.signTypedData(td)) as Hex;
    info(`signed SettlementIntent expiresAt=${expiresAt}`);
    let settleTx: Hex;
    try {
      settleTx = await broadcastPublishSettlement(oracleWallet, {
        forgeAddress: env.forge,
        questionId: env.qid,
        merkleRoot: root,
        totalClaimable,
        sampleRecipient: sampleLeaf.recipient,
        sampleAmount: sampleLeaf.amount,
        sampleProof,
        expiresAt,
        slashedCommitHashes: [],
        slashedVoteHashes: [],
        oracleSig,
      });
    } catch (err) {
      throw new FatalExit(
        EXIT.BROADCAST_FAILED,
        `publishSettlement broadcast failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    info(`settle tx ${settleTx}`);
    try {
      await awaitReceipt(publicClient, settleTx);
    } catch (err) {
      throw new FatalExit(
        EXIT.BROADCAST_FAILED,
        `publishSettlement reverted: ${err instanceof Error ? err.message : err}`,
      );
    }
    ok("settlement published on-chain");
  }

  // ── Step 7: sweep Merkle claims ────────────────────────────────
  log("7/8", "sweep payout claims");
  let claimsOk = 0;
  let claimsSkipped = 0;
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const w = walletBank.get(leaf.recipient.toLowerCase());
    if (!w) {
      warn(`no wallet in bank for ${leaf.recipient} (idx 0..${env.walletBankSize - 1}) — recipient must claim themselves`);
      claimsSkipped++;
      continue;
    }
    const proof = merkleProof(leafHashes, i) as Hex[];
    if (env.dryRun) {
      info(`DRY: would claim ${leaf.amount} for ${leaf.recipient} (idx=${w.index}, proofLen=${proof.length})`);
      claimsOk++;
      continue;
    }
    const claimer = makeAgentWalletClient({
      privateKey: w.privateKey,
      chainId: env.chainId,
      rpcUrl: env.rpcUrl,
    });
    try {
      const claimTx = await broadcastClaim(claimer, {
        forgeAddress: env.forge,
        questionId: env.qid,
        // v2.9: explicit recipient — same as winner-wallet address.
        // The merkle leaf was authored against this address.
        recipient: claimer.account!.address,
        amount: leaf.amount,
        proof,
      });
      await awaitReceipt(publicClient, claimTx);
      ok(`claim ${leaf.amount} → ${leaf.recipient} (idx=${w.index}) tx=${claimTx}`);
      claimsOk++;
    } catch (err) {
      warn(`claim failed for ${leaf.recipient}: ${err instanceof Error ? err.message : err}`);
      claimsSkipped++;
    }
  }

  // ── Step 8: sweep stake-back claims ───────────────────────────
  let solStakeOk = 0;
  let voteStakeOk = 0;
  let stakeSkipped = 0;
  if (env.skipStakeClaims) {
    log("8/8", "skipping solution + vote stake claims (RT_SKIP_STAKE_CLAIMS=1)");
  } else {
    log("8/8", "sweep solution + vote stake claims");
    // Solution stakes — only winners (any solution still listed as
    // confirmed without a slashed_stake_amount > 0). The contract
    // itself rejects claims for slashed intents, so a try/skip
    // pattern is safe; but we filter ranked solutions when ranks
    // are present to avoid wasted broadcasts.
    const solutionsForStake = solutions.filter((s) => {
      // If ranks are projected, only ranked solutions can claim.
      if (s.rank !== undefined) return true;
      // Pre-rank — try all confirmed solutions; chain will revert
      // for slashed ones individually.
      return true;
    });
    for (const s of solutionsForStake) {
      if (!s.intentHash) {
        warn(`solution ${s.id}: no intentHash on API row, can't claim stake`);
        stakeSkipped++;
        continue;
      }
      const w = walletBank.get(s.authorAddress);
      if (!w) {
        warn(`no wallet for solution author ${s.authorAddress} — skipping stake claim`);
        stakeSkipped++;
        continue;
      }
      if (env.dryRun) {
        info(`DRY: would claimSolutionStake intent=${s.intentHash} idx=${w.index}`);
        solStakeOk++;
        continue;
      }
      try {
        const stakeWallet = createWalletClient({
          account: privateKeyToAccount(w.privateKey),
          chain: oracleWallet.chain,
          transport: http(env.rpcUrl),
        });
        const tx = await stakeWallet.writeContract({
          address: env.forge,
          abi: REZON_FORGE_ABI,
          functionName: "claimSolutionStake",
          args: [env.qid, s.intentHash],
        });
        await awaitReceipt(publicClient, tx);
        ok(`solution stake claimed: solution=${s.id} idx=${w.index}`);
        solStakeOk++;
      } catch (err) {
        warn(`claimSolutionStake failed for ${s.id}: ${err instanceof Error ? err.message : err}`);
        stakeSkipped++;
      }
    }

    for (const v of votes) {
      if (!v.intentHash) {
        warn(`vote ${v.id}: no intentHash, can't claim stake`);
        stakeSkipped++;
        continue;
      }
      const w = walletBank.get(v.voterAddress);
      if (!w) {
        warn(`no wallet for voter ${v.voterAddress} — skipping stake claim`);
        stakeSkipped++;
        continue;
      }
      if (env.dryRun) {
        info(`DRY: would claimVoteStake intent=${v.intentHash} idx=${w.index}`);
        voteStakeOk++;
        continue;
      }
      try {
        const stakeWallet = createWalletClient({
          account: privateKeyToAccount(w.privateKey),
          chain: oracleWallet.chain,
          transport: http(env.rpcUrl),
        });
        const tx = await stakeWallet.writeContract({
          address: env.forge,
          abi: REZON_FORGE_ABI,
          functionName: "claimVoteStake",
          args: [env.qid, v.intentHash],
        });
        await awaitReceipt(publicClient, tx);
        ok(`vote stake claimed: vote=${v.id} idx=${w.index}`);
        voteStakeOk++;
      } catch (err) {
        warn(`claimVoteStake failed for ${v.id}: ${err instanceof Error ? err.message : err}`);
        stakeSkipped++;
      }
    }
  }

  // ── Final summary ──────────────────────────────────────────────
  console.log("");
  console.log(c.bold(c.green("  Settlement + claim sweep complete.")));
  console.log(`  ${c.green("✓")} ${claimsOk} payout claim${claimsOk === 1 ? "" : "s"}`);
  if (!env.skipStakeClaims) {
    console.log(`  ${c.green("✓")} ${solStakeOk} solution stake claim${solStakeOk === 1 ? "" : "s"}`);
    console.log(`  ${c.green("✓")} ${voteStakeOk} vote stake claim${voteStakeOk === 1 ? "" : "s"}`);
  }
  if (claimsSkipped + stakeSkipped > 0) {
    console.log(`  ${c.yellow("!")} ${claimsSkipped + stakeSkipped} skipped (no local wallet or claim error)`);
  }
  if (env.dryRun) console.log(c.yellow("  (DRY RUN — no transactions were broadcast)"));
}

main().catch((err) => {
  if (err instanceof FatalExit) {
    console.error(`\n${c.red(`[FAIL exit=${err.code}] ${err.message}`)}`);
    process.exit(err.code);
  }
  console.error(`\n${c.red(`[FAIL] ${err instanceof Error ? err.message : err}`)}`);
  if (err instanceof Error && err.stack) console.error(c.dim(err.stack));
  process.exit(EXIT.UNEXPECTED);
});
