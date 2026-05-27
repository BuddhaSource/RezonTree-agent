#!/usr/bin/env tsx
// claim-sweep.ts — pulls every money-out a fleet wallet (idx 0-11) is owed
// across a set of questions and broadcasts it via the v2 withdraw door.
//
// v1 → v2 shift (PURPOSE unchanged): v1 read GET /v1/accounts/:addr?
// include=claims and broadcast the REMOVED Router.claim per row. v2 routes
// every money-out through the unified withdraw door + the single chain
// entry pullValue. This script now defers to scripts/lib/operator-recovery
// (runClaimFlow / runRefundFlow), the same path the live MCP `withdraw`
// tool uses — so it recovers winner claims AND stake/sponsor refunds.
//
// Idempotent: an already-claimed leaf drops off the door's eligible list,
// so a re-run is safe.
//
// Usage:
//   set -a; source .env; set +a
//   RT_AGENT_BACKEND_URL=http://localhost:8080 \
//     npx tsx scripts/claim-sweep.ts qst_aaa qst_bbb ...

import "dotenv/config";
import { formatUnits, type Address } from "viem";

import {
  buildWalletBank,
  loginWallet,
  sweepWalletQuestion,
  type SweepOptions,
} from "./lib/operator-recovery.js";

const API = process.env.RT_AGENT_BACKEND_URL || process.env.RT_API_BASE || "http://localhost:8080";
const FORGE = (process.env.RT_FORGE_ADDRESS ||
  process.env.FORGE_SIGNING_VERIFYING_CONTRACT) as Address;
const RPC = process.env.RT_RPC_URL || "https://sepolia.base.org";
const CHAIN_ID = Number(process.env.RT_AGENT_CHAIN_ID || process.env.RT_CHAIN_ID || "84532");
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const DRY_RUN = process.env.RT_DRY_RUN === "1";
const BANK_SIZE = Number(process.env.RT_WALLET_BANK_SIZE || "12");

if (!MNEMONIC || !FORGE) {
  console.error("RT_AGENT_MNEMONIC + RT_FORGE_ADDRESS required");
  process.exit(2);
}

async function main() {
  const qids = process.argv.slice(2).filter((s) => s.startsWith("qst_"));
  if (qids.length === 0) {
    console.error(
      "Pass one or more qst_ question ids — the v2 withdraw door is per-question.\n" +
        "  e.g. npx tsx scripts/claim-sweep.ts qst_aaa qst_bbb",
    );
    process.exit(2);
  }

  console.log(`Forge: ${FORGE}`);
  console.log(`API:   ${API}`);
  console.log(`RPC:   ${RPC}`);
  console.log(`Questions: ${qids.length} · dryRun=${DRY_RUN}\n`);

  const bank = buildWalletBank(MNEMONIC, BANK_SIZE, CHAIN_ID);
  const sweepOpts: SweepOptions = {
    apiBase: API.replace(/\/$/, ""),
    forgeAddress: FORGE,
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    dryRun: DRY_RUN,
  };

  let total = 0n;
  let items = 0;
  let failed = 0;
  for (const w of bank.values()) {
    let bearer: string;
    try {
      ({ bearer } = await loginWallet(sweepOpts.apiBase, MNEMONIC, w.index));
    } catch (e) {
      console.error(`  login idx=${w.index} failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (const qid of qids) {
      const r = await sweepWalletQuestion(sweepOpts, w, bearer, qid).catch((e) => {
        console.error(`  withdraw idx=${w.index} q=${qid} failed: ${e instanceof Error ? e.message : e}`);
        return null;
      });
      if (!r || r.eligibleCount === 0) continue;
      console.log(`── wallet idx ${w.index} ${w.address} q=${qid} (${r.eligibleCount} eligible)`);
      total += r.totalWithdrawnWei;
      failed += r.failures;
      for (const item of r.items) {
        if (item.status === "broadcast") {
          items++;
          console.log(
            `   ${DRY_RUN ? "DRY" : "✓"} ${item.actionType} role=${item.role} ` +
              `${formatUnits(item.amountWei, 6)} USDC${item.txHash ? ` tx=${item.txHash}` : ""}`,
          );
        } else {
          console.log(`   ✗ ${item.actionType} role=${item.role}: ${item.error}`);
        }
      }
    }
  }
  console.log(
    `\n── Done. ${items} item(s) ${DRY_RUN ? "(dry-run)" : "broadcast"}, ` +
      `${formatUnits(total, 6)} USDC, ${failed} failed.`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
