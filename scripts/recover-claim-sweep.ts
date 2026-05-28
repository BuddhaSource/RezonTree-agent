#!/usr/bin/env tsx
/**
 * recover-claim-sweep.ts — one-shot money-out sweeper for the fleet bank.
 *
 * v1 → v2 shift (PURPOSE unchanged: pull every claimable payout for the
 * fleet wallets across a set of settled questions):
 *   • v1 hit the public /v1/wallet-claims batch endpoint for canonical
 *     proofs, then broadcast the REMOVED Router `claim(qid,recipient,
 *     amount,proof)` per row.
 *   • v2 routes every money-out through the unified withdraw door
 *     (POST /v1/questions/:id/intents/preflight {actionType:"withdraw"})
 *     and the single chain entry `pullValue`. This script logs in each
 *     fleet wallet and calls the shared sweep helper (runClaimFlow /
 *     runRefundFlow → pullValue), which is the same money-out path the
 *     live MCP `withdraw` tool uses. Note: the withdraw door returns
 *     refunds too, so this "claim sweep" now also recovers stake/sponsor
 *     refunds on the listed questions — a superset of the v1 behaviour.
 *
 * Usage:
 *   RT_AGENT_MNEMONIC=... RT_FORGE_ADDRESS=0x... \
 *     npx tsx scripts/recover-claim-sweep.ts qst_aaa qst_bbb ...
 *   # qids are REQUIRED — the withdraw door is per-question.
 *
 * Env (defaults in []):
 *   RT_AGENT_MNEMONIC   required
 *   RT_FORGE_ADDRESS    required
 *   RT_RPC_URL          [https://sepolia.base.org]
 *   RT_CHAIN_ID         [84532]
 *   RT_API_BASE         [http://localhost:8080]
 *   RT_WALLET_BANK_SIZE [30]
 *   RT_DRY_RUN          [0]   "1" to skip broadcast
 */
import "dotenv/config";
import { formatUnits, type Address } from "viem";

import {
  buildWalletBank,
  loginWallet,
  sweepWalletQuestion,
  type SweepOptions,
} from "./lib/operator-recovery.js";

async function main() {
  const qids = process.argv.slice(2).filter((s) => s.startsWith("qst_"));
  const mnemonic = process.env.RT_AGENT_MNEMONIC;
  const forge = process.env.RT_FORGE_ADDRESS;
  if (!mnemonic || !forge) {
    console.error("RT_AGENT_MNEMONIC and RT_FORGE_ADDRESS required");
    process.exit(2);
  }
  if (qids.length === 0) {
    console.error(
      "Pass one or more qst_ question ids — the v2 withdraw door is per-question.\n" +
        "  e.g. npx tsx scripts/recover-claim-sweep.ts qst_aaa qst_bbb",
    );
    process.exit(2);
  }
  const apiBase = (process.env.RT_API_BASE ?? "http://localhost:8080").replace(/\/$/, "");
  const rpcUrl = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
  const chainId = Number(process.env.RT_CHAIN_ID ?? "84532");
  const bankSize = Number(process.env.RT_WALLET_BANK_SIZE ?? "30");
  const dryRun = process.env.RT_DRY_RUN === "1";

  const bank = buildWalletBank(mnemonic, bankSize, chainId);
  console.log(`[sweep] fleet=${bank.size} wallets · questions=${qids.length} · dryRun=${dryRun}`);

  const sweepOpts: SweepOptions = {
    apiBase,
    forgeAddress: forge as Address,
    rpcUrl,
    chainId,
    dryRun,
  };

  let totalWithdrawn = 0n;
  let attempts = 0;
  let failed = 0;

  for (const w of bank.values()) {
    let bearer: string;
    try {
      ({ bearer } = await loginWallet(apiBase, mnemonic, w.index));
    } catch (err) {
      console.error(`  login idx=${w.index} failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const qid of qids) {
      const r = await sweepWalletQuestion(sweepOpts, w, bearer, qid).catch((err) => {
        console.error(`  withdraw idx=${w.index} q=${qid} failed: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      if (!r || r.eligibleCount === 0) continue;
      totalWithdrawn += r.totalWithdrawnWei;
      failed += r.failures;
      for (const item of r.items) {
        if (item.status === "broadcast") {
          attempts++;
          console.log(
            `  ${dryRun ? "DRY" : "✓"} ${item.actionType.padEnd(6)} ${formatUnits(item.amountWei, 6).padStart(10)} USDC ` +
              `→ ${w.address} q=${qid.slice(0, 12)}…${item.txHash ? ` tx=${item.txHash}` : ""}`,
          );
        } else {
          console.warn(`  ✗ ${item.actionType} idx=${w.index} q=${qid}: ${item.error}`);
        }
      }
    }
  }

  console.log(
    `\n[done] items=${attempts} withdrawn=${formatUnits(totalWithdrawn, 6)} USDC failed=${failed}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
