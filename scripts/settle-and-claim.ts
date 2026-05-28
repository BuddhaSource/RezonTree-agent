#!/usr/bin/env tsx
/**
 * settle-and-claim.ts — Quadphase v2 settlement-await + money-out sweep
 * for any question. Run by an operator after a question's round closes.
 *
 * v1 → v2 shift (the mechanics changed, the PURPOSE did not):
 *   • PURPOSE (unchanged): get a question settled, then pull every winner
 *     payout + every recoverable stake/sponsor refund back to the fleet
 *     wallets.
 *   • SETTLEMENT (changed). v1 had this script re-derive the payout split
 *     + Merkle tree CLIENT-SIDE, sign a v1 SettlementIntent, and broadcast
 *     the removed `publishSettlement(SettlementIntent,sig)`. In v2 the
 *     authoritative settler is the BACKEND ORACLE KEEPER
 *     (internal/oracle/keeper.go): it builds the SettleWitness, signs
 *     once with the oracle key, and broadcasts
 *     `publishSettlement(env,sig,witnessBytes)` itself — with reorg
 *     recovery and a persisted-root drift guard. Re-deriving the tree
 *     here would risk signing a root that drifts from the backend's
 *     authoritative one. So this script now AWAITS the keeper (polls the
 *     chain getSettlementProgress / getQuestionScalars views until the
 *     question reaches Settled), rather than computing payouts. A manual
 *     oracle-side broadcast fallback (runSettleFlow) is available only
 *     when the operator explicitly supplies an oracle-computed
 *     SettleWitness via RT_SETTLE_WITNESS_JSON (escape hatch for a
 *     stalled keeper; off by default).
 *   • CLAIM + STAKE RECOVERY (changed). v1 broadcast the removed
 *     claim / claimSolutionStake / claimVoteStake per winner. v2 has a
 *     single chain door, `pullValue`, and a single backend door that
 *     enumerates everything a signer is owed (claims + refunds) with
 *     proofs/amounts/nonces pre-computed:
 *       POST /v1/questions/:id/intents/preflight {actionType:"withdraw"}.
 *     This script logs in each fleet wallet, calls that door, and signs +
 *     broadcasts each eligible item via runClaimFlow / runRefundFlow
 *     (shared in scripts/lib/operator-recovery.ts, mirroring the live MCP
 *     `withdraw` tool). The backend, not the client, owns the merkle math.
 *
 * Required env:
 *   RT_QID                      — bytes32 question id (0x...)
 *   RT_FORGE_ADDRESS            — RezonForge address
 *   RT_AGENT_MNEMONIC           — 12/24-word BIP-39 phrase (fleet bank)
 *
 * Optional env:
 *   RT_API_BASE                 — default http://localhost:8080
 *   RT_RPC_URL                  — default https://sepolia.base.org
 *   RT_CHAIN_ID                 — default 84532
 *   RT_DRY_RUN                  — "1" to skip all broadcasts
 *   RT_WALLET_BANK_SIZE         — default 30 (fleet search depth)
 *   RT_SETTLE_WAIT_SECONDS      — default 180 (how long to await keeper)
 *   RT_SETTLE_POLL_SECONDS      — default 10 (chain poll interval)
 *   RT_ORACLE_WALLET_INDEX      — default 0 (manual-settle signer)
 *   RT_SETTLE_WITNESS_JSON      — manual oracle-settle escape hatch (see
 *                                 below). When set, the script signs +
 *                                 broadcasts publishSettlement itself.
 *
 * RT_SETTLE_WITNESS_JSON shape (all amounts decimal strings / numbers):
 *   { "merkleRoot":"0x..", "totalClaimable":"..", "dustFolded":"0",
 *     "slashes":[{"intentHash":"0x..","amount":"..","role":<u8>}],
 *     "leafCount":"..", "slashEntryOffset":"0", "totalSlashEntries":".." }
 *
 * Exit codes:
 *   0  success
 *   1  required env missing
 *   2  settlement did not complete within the wait window
 *   3  no question / not in a settleable state
 *   4  settle/withdraw broadcast failed
 *   5  unexpected
 */

import "dotenv/config";
import type { Address, Hex } from "viem";
import { createPublicClient, formatUnits, http } from "viem";

import {
  awaitReceipt,
  makeAgentWalletClient,
} from "../src/forge/quadphase-broadcast.js";
import { runSettleFlow } from "../src/forge/quadphase-flow.js";
import type { FeeDistribution, SlashEntry } from "../src/intents/settle-witness.js";
import {
  buildWalletBank,
  loginWallet,
  sweepWalletQuestion,
  type SweepOptions,
  type SweepWalletResult,
} from "./lib/operator-recovery.js";
import { deriveAgentWallet } from "../src/wallet/derive.js";

// ─── Exit-code helpers ───────────────────────────────────────────

const EXIT = {
  OK: 0,
  ENV_MISSING: 1,
  SETTLE_TIMEOUT: 2,
  NOT_SETTLEABLE: 3,
  BROADCAST_FAILED: 4,
  UNEXPECTED: 5,
} as const;

class FatalExit extends Error {
  constructor(public code: number, msg: string) {
    super(msg);
  }
}

// ─── Color helpers ───────────────────────────────────────────────

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

// ─── Chain view ABI (v2 getters) ─────────────────────────────────

const VIEW_ABI = [
  {
    type: "function",
    name: "getQuestionScalars",
    stateMutability: "view",
    inputs: [{ name: "qid", type: "bytes32" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "status", type: "uint8" },
      { name: "poolAmount", type: "uint256" },
      { name: "feeShareSet", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getSettlementProgress",
    stateMutability: "view",
    inputs: [{ name: "qid", type: "bytes32" }],
    outputs: [
      { name: "root", type: "bytes32" },
      { name: "batchOffset", type: "uint256" },
      { name: "totalSlashes", type: "uint256" },
      { name: "totalClaimable", type: "uint256" },
      { name: "settlementStartedAt", type: "uint256" },
    ],
  },
] as const;

// QuestionStatus enum (contracts/src/QuadphaseTypes.sol).
const STATUS_NONE = 0;
const STATUS_OPEN = 1;
const STATUS_SETTLING = 2;
const STATUS_SETTLED = 3;
const STATUS_ABANDONED = 4;
const STATUS_RECOVERED = 5;
const STATUS_NAME: Record<number, string> = {
  [STATUS_NONE]: "None",
  [STATUS_OPEN]: "Open",
  [STATUS_SETTLING]: "Settling",
  [STATUS_SETTLED]: "Settled",
  [STATUS_ABANDONED]: "Abandoned",
  [STATUS_RECOVERED]: "Recovered",
};

// ─── Env parsing ─────────────────────────────────────────────────

interface Env {
  qid: Hex;
  forge: Address;
  mnemonic: string;
  apiBase: string;
  rpcUrl: string;
  chainId: number;
  dryRun: boolean;
  walletBankSize: number;
  settleWaitSeconds: number;
  settlePollSeconds: number;
  oracleIdx: number;
  settleWitnessJson?: string;
}

function parseEnv(): Env {
  const qid = process.env.RT_QID;
  const forge = process.env.RT_FORGE_ADDRESS;
  const mnemonic = process.env.RT_AGENT_MNEMONIC;
  if (!qid || !/^0x[0-9a-fA-F]{64}$/.test(qid)) {
    throw new FatalExit(EXIT.ENV_MISSING, "RT_QID required (bytes32 question id, 0x + 64 hex)");
  }
  if (!forge || !/^0x[0-9a-fA-F]{40}$/.test(forge)) {
    throw new FatalExit(EXIT.ENV_MISSING, "RT_FORGE_ADDRESS required (RezonForge address)");
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
    chainId: Number.parseInt(process.env.RT_CHAIN_ID ?? "84532", 10),
    dryRun: process.env.RT_DRY_RUN === "1",
    walletBankSize: Number.parseInt(process.env.RT_WALLET_BANK_SIZE ?? "30", 10),
    settleWaitSeconds: Number.parseInt(process.env.RT_SETTLE_WAIT_SECONDS ?? "180", 10),
    settlePollSeconds: Number.parseInt(process.env.RT_SETTLE_POLL_SECONDS ?? "10", 10),
    oracleIdx: Number.parseInt(process.env.RT_ORACLE_WALLET_INDEX ?? "0", 10),
    settleWitnessJson: process.env.RT_SETTLE_WITNESS_JSON,
  };
}

// ─── Chain reads ─────────────────────────────────────────────────

interface ChainView {
  token: Address;
  status: number;
  poolAmount: bigint;
  settlementStartedAt: bigint;
  settlementRoot: Hex;
}

async function readChain(
  pub: ReturnType<typeof createPublicClient>,
  forge: Address,
  qid: Hex,
): Promise<ChainView> {
  const scalars = (await pub.readContract({
    address: forge,
    abi: VIEW_ABI,
    functionName: "getQuestionScalars",
    args: [qid],
  })) as readonly [Address, number, bigint, boolean];
  let root: Hex = ("0x" + "0".repeat(64)) as Hex;
  let startedAt = 0n;
  try {
    const prog = (await pub.readContract({
      address: forge,
      abi: VIEW_ABI,
      functionName: "getSettlementProgress",
      args: [qid],
    })) as readonly [Hex, bigint, bigint, bigint, bigint];
    root = prog[0];
    startedAt = prog[4];
  } catch {
    /* progress view may revert for never-settling questions; ignore */
  }
  return {
    token: scalars[0],
    status: Number(scalars[1]),
    poolAmount: scalars[2],
    settlementStartedAt: startedAt,
    settlementRoot: root,
  };
}

// ─── Manual oracle-settle escape hatch ───────────────────────────

function parseSettleWitnessJson(raw: string): {
  merkleRoot: Hex;
  totalClaimable: bigint;
  feeTotal: bigint;
  slashes: SlashEntry[];
  leafCount: bigint;
  slashEntryOffset: bigint;
  totalSlashEntries: bigint;
  feeDistributions: FeeDistribution[];
} {
  const j = JSON.parse(raw) as {
    merkleRoot: string;
    totalClaimable: string | number;
    // Fee-model rename: feeTotal supersedes dustFolded (economics.md §0).
    feeTotal?: string | number;
    dustFolded?: string | number;
    slashes?: Array<{ intentHash: string; amount: string | number; role: number }>;
    leafCount: string | number;
    slashEntryOffset?: string | number;
    totalSlashEntries?: string | number;
    feeDistributions?: Array<{ recipient: string; amount: string | number }>;
  };
  if (!/^0x[0-9a-fA-F]{64}$/.test(j.merkleRoot)) {
    throw new FatalExit(EXIT.ENV_MISSING, `RT_SETTLE_WITNESS_JSON.merkleRoot malformed: ${j.merkleRoot}`);
  }
  const slashes: SlashEntry[] = (j.slashes ?? []).map((s) => ({
    intentHash: s.intentHash as Hex,
    amount: BigInt(s.amount),
    role: s.role,
  }));
  return {
    merkleRoot: j.merkleRoot as Hex,
    totalClaimable: BigInt(j.totalClaimable),
    feeTotal: BigInt(j.feeTotal ?? j.dustFolded ?? 0),
    slashes,
    leafCount: BigInt(j.leafCount),
    slashEntryOffset: BigInt(j.slashEntryOffset ?? 0),
    totalSlashEntries: BigInt(j.totalSlashEntries ?? slashes.length),
    feeDistributions: (j.feeDistributions ?? []).map((f) => ({
      recipient: f.recipient as Hex,
      amount: BigInt(f.amount),
    })),
  };
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const env = parseEnv();
  log(
    "settle-and-claim",
    c.bold(`qid ${env.qid.slice(0, 10)}… | forge ${env.forge.slice(0, 10)}… | dryRun=${env.dryRun ? "yes" : "no"}`),
  );
  info(`api ${env.apiBase}`);
  info(`rpc ${env.rpcUrl} (chainId ${env.chainId})`);

  const pub = createPublicClient({ transport: http(env.rpcUrl) });

  // ── Step 1: read question state from chain ─────────────────────
  log("1/4", "read question state (chain views)");
  let view = await readChain(pub, env.forge, env.qid);
  ok(`chain: status=${STATUS_NAME[view.status] ?? view.status} pool=${view.poolAmount} token=${view.token.slice(0, 10)}…`);

  if (view.status === STATUS_NONE) {
    throw new FatalExit(EXIT.NOT_SETTLEABLE, "question not found on chain (status=None)");
  }
  if (view.status === STATUS_ABANDONED || view.status === STATUS_RECOVERED) {
    info(`question is ${STATUS_NAME[view.status]} — settlement N/A; proceeding straight to refund sweep`);
  }

  // ── Step 2: ensure settled (await keeper, or manual escape hatch) ─
  if (view.status === STATUS_SETTLED) {
    log("2/4", "already Settled — skipping settle, going straight to sweep");
  } else if (view.status === STATUS_ABANDONED || view.status === STATUS_RECOVERED) {
    log("2/4", "skip settle (terminal non-settled state — refunds only)");
  } else if (env.settleWitnessJson) {
    // Manual oracle escape hatch: operator supplied an oracle-computed
    // SettleWitness. Sign + broadcast publishSettlement ourselves.
    log("2/4", c.yellow("manual oracle settle (RT_SETTLE_WITNESS_JSON supplied)"));
    const w = parseSettleWitnessJson(env.settleWitnessJson);
    const oracle = deriveAgentWallet(env.mnemonic, env.oracleIdx, env.chainId);
    ok(`oracle wallet idx=${env.oracleIdx} → ${oracle.address}`);
    if (env.dryRun) {
      info(`DRY: would publishSettlement merkleRoot=${w.merkleRoot} totalClaimable=${w.totalClaimable} slashes=${w.slashes.length}`);
    } else {
      const { bearer } = await loginWallet(env.apiBase, env.mnemonic, env.oracleIdx);
      const walletClient = makeAgentWalletClient({
        privateKey: oracle.privateKey as Hex,
        chainId: env.chainId,
        rpcUrl: env.rpcUrl,
      });
      try {
        const result = await runSettleFlow({
          signer: oracle.address as Address,
          qid: env.qid,
          questionId: env.qid, // operator passes the bytes32 qid; the
          // intents URL accepts the qst_ id, but for manual settle we
          // address by qid — backend resolves either form.
          nonce: 0n, // manual escape hatch — operator should override via
          // RT_SETTLE_WITNESS_JSON tooling if nonce collision occurs.
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 1800),
          forgeAddress: env.forge,
          chainId: env.chainId,
          token: view.token,
          ...w,
          bearerToken: bearer,
          baseUrl: env.apiBase,
          walletClient,
          privateKey: oracle.privateKey as Hex,
        });
        await awaitReceipt(pub as never, result.txHash!);
        ok(`manual settlement published: tx=${result.txHash}`);
      } catch (err) {
        throw new FatalExit(
          EXIT.BROADCAST_FAILED,
          `manual publishSettlement failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    view = await readChain(pub, env.forge, env.qid);
  } else {
    // Default path: await the backend oracle keeper's settlement.
    log("2/4", `awaiting backend oracle keeper settlement (≤${env.settleWaitSeconds}s)`);
    const deadline = Date.now() + env.settleWaitSeconds * 1000;
    while (view.status !== STATUS_SETTLED) {
      if (Date.now() >= deadline) {
        throw new FatalExit(
          EXIT.SETTLE_TIMEOUT,
          `question still ${STATUS_NAME[view.status] ?? view.status} after ${env.settleWaitSeconds}s. ` +
            `The backend oracle keeper (internal/oracle/keeper.go) owns settlement — check its logs / SLO metrics, ` +
            `or supply RT_SETTLE_WITNESS_JSON to settle manually.`,
        );
      }
      info(`status=${STATUS_NAME[view.status] ?? view.status} (settlementStartedAt=${view.settlementStartedAt}) — polling…`);
      await new Promise((r) => setTimeout(r, env.settlePollSeconds * 1000));
      view = await readChain(pub, env.forge, env.qid);
    }
    ok(`question reached Settled (root=${view.settlementRoot.slice(0, 14)}…)`);
  }

  // ── Step 3: sweep money-out for the fleet (withdraw door) ──────
  log("3/4", "sweep claims + refunds for fleet wallets (withdraw door)");
  const bank = buildWalletBank(env.mnemonic, env.walletBankSize, env.chainId);
  info(`wallet bank size = ${bank.size} (idx 0..${env.walletBankSize - 1})`);

  const sweepOpts: SweepOptions = {
    apiBase: env.apiBase,
    forgeAddress: env.forge,
    rpcUrl: env.rpcUrl,
    chainId: env.chainId,
    dryRun: env.dryRun,
  };

  const results: SweepWalletResult[] = [];
  let totalWithdrawn = 0n;
  let totalItems = 0;
  let totalFailures = 0;
  for (const w of bank.values()) {
    let bearer: string;
    try {
      ({ bearer } = await loginWallet(env.apiBase, env.mnemonic, w.index));
    } catch (err) {
      warn(`login idx=${w.index} (${w.address.slice(0, 10)}…) failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const r = await sweepWalletQuestion(sweepOpts, w, bearer, env.qid).catch((err) => {
      warn(`withdraw idx=${w.index} (${w.address.slice(0, 10)}…) failed: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (!r || r.eligibleCount === 0) continue;
    results.push(r);
    totalWithdrawn += r.totalWithdrawnWei;
    totalItems += r.items.filter((i) => i.status === "broadcast").length;
    totalFailures += r.failures;
    for (const item of r.items) {
      if (item.status === "broadcast") {
        ok(`${env.dryRun ? "DRY " : ""}${item.actionType} (${item.role}) ${formatUnits(item.amountWei, 6)} USDC → idx=${w.index}${item.txHash ? ` tx=${item.txHash}` : ""}`);
      } else {
        warn(`${item.actionType} (${item.role}) idx=${w.index} FAILED: ${item.error}`);
      }
    }
  }

  // ── Step 4: summary ────────────────────────────────────────────
  log("4/4", "summary");
  console.log("");
  console.log(c.bold(c.green("  Settle + money-out sweep complete.")));
  console.log(`  ${c.green("✓")} ${totalItems} item${totalItems === 1 ? "" : "s"} ${env.dryRun ? "(dry-run)" : "broadcast"} across ${results.length} wallet(s)`);
  console.log(`  ${c.green("✓")} total ${formatUnits(totalWithdrawn, 6)} USDC ${env.dryRun ? "claimable" : "withdrawn"}`);
  if (totalFailures > 0) {
    console.log(`  ${c.yellow("!")} ${totalFailures} item(s) failed — re-run to retry (already-broadcast items drop off the eligible list)`);
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
