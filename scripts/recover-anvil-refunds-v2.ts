// scripts/recover-anvil-refunds-v2.ts — Drive pullValue(Refund) for every
// eligible contributor + staker across the 19 locally-recovered questions
// on anvil chainId=31337, working around the +90d clock-skew between
// host (server clock) and anvil block.timestamp.
//
// Strategy: fetch each withdraw draft, ignore the draft's
// `recommendedExpiresAt` (which is host_now + 5min and ~90d in anvil's
// past), and instead use `anvil_block.timestamp + 1h`. Drop
// `expectedIntentHash` since recompute will differ. Backend Stage-2 has
// no upper bound on expiresAt and re-derives the hash from POSTed
// envelope. Chain accepts as long as expiresAt > block.timestamp.
//
// Token fallback: some drafts return funds.token=0x0 — fall back to
// RT_USDC_ADDRESS for the envelope's token field. Backend re-derives
// intent_hash from the posted envelope, so this is fine.
//
// Run: pnpm tsx scripts/recover-anvil-refunds-v2.ts

import "dotenv/config";

import {
  createPublicClient,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";

import {
  buildWalletBank,
  loginWallet,
  fetchWithdrawDraft,
  type DerivedWallet,
} from "./lib/operator-recovery.js";
import {
  makeAgentWalletClient,
  awaitReceipt,
} from "../src/forge/quadphase-broadcast.js";
import { runRefundFlow } from "../src/forge/quadphase-flow.js";

const FORGE = (process.env.RT_FORGE_ADDRESS ?? "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9") as Address;
const USDC = (process.env.RT_USDC_ADDRESS ?? "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0") as Address;
const RPC = process.env.RT_RPC_URL ?? "http://localhost:8545";
const API = (process.env.RT_BACKEND_URL ?? process.env.RT_API_BASE ?? "http://localhost:8080").replace(/\/$/, "");
const CHAIN_ID = Number.parseInt(process.env.RT_CHAIN_ID ?? "31337", 10);
const MNEMONIC = process.env.RT_AGENT_MNEMONIC ?? "bulb excite inform release demand course team photo hobby wait vast please";

const QUESTIONS: string[] = [
  "qst_d8bsxwc6m5zfngpgz0c0", "qst_d8bszhcq8t1mpkd5fpz0",
  "qst_d8bt02jctnyttmyvxgmg", "qst_d8bt10ngz2g5x69atrhg",
  "qst_d8bt7z6642d97v0bas20", "qst_d8bt8yn2ab15fpd9cez0",
  "qst_d8bt9hmhp0rgrp85pj0g", "qst_d8btavc32ekx8xf75dn0",
  "qst_d8btcbk71kdvwwkte90g", "qst_d8btd7rtc7nc4sg939y0",
  "qst_d8btdjwy5fk69ffrcdeg", "qst_d8btfkh62rjz07y6f7g0",
  "qst_d8btgj5mhg4rymcsws9g", "qst_d8btp3j7fdtewe1hdwq0",
  "qst_d8bttadjkagatwa48410",
];

const ACTIVE_IDX: number[] = [1, 2, 4];
const IDX_NAME: Record<number, string> = { 1: "sponsor1", 2: "solver2", 4: "solver4" };

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
] as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

async function balanceOf(pub: ReturnType<typeof createPublicClient>, holder: Address): Promise<bigint> {
  return (await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [holder] })) as bigint;
}

interface RefundResult {
  question: string;
  agentIdx: number;
  role: string;
  amount: bigint;
  status: "broadcast" | "failed";
  txHash?: string;
  intentHash?: string;
  error?: string;
}

async function main() {
  console.log("\n========================================================");
  console.log("  ANVIL RECOVERED-19 REFUND SWEEP v2 (clock-skew-aware)");
  console.log("========================================================");
  const pub = createPublicClient({ transport: http(RPC) });
  const latest = await pub.getBlock();
  const anvilTs = Number(latest.timestamp);
  const hostNow = Math.floor(Date.now() / 1000);
  const expiresAt = BigInt(anvilTs + 3600);
  console.log(`  anvil block.timestamp:  ${anvilTs}  (${new Date(anvilTs * 1000).toISOString()})`);
  console.log(`  host now:               ${hostNow}  (${new Date(hostNow * 1000).toISOString()})`);
  console.log(`  skew (anvil - host):    +${anvilTs - hostNow}s (${((anvilTs - hostNow) / 86400).toFixed(2)}d)`);
  console.log(`  envelope.expiresAt:     ${expiresAt}  (anvil_ts + 1h)`);
  console.log(`  forge:                  ${FORGE}`);
  console.log(`  token override:         ${USDC}`);
  console.log("");

  const bank = buildWalletBank(MNEMONIC, 10, CHAIN_ID);
  const byIdx = new Map<number, DerivedWallet>();
  for (const w of bank.values()) byIdx.set(w.index, w);

  const forgePre = await balanceOf(pub, FORGE);
  console.log(`  forge mUSDC pre-sweep:  ${formatUnits(forgePre, 6)} USDC`);
  const agentPre = new Map<number, bigint>();
  for (const idx of ACTIVE_IDX) {
    const bal = await balanceOf(pub, byIdx.get(idx)!.address);
    agentPre.set(idx, bal);
    console.log(`    idx${idx} ${IDX_NAME[idx].padEnd(8)} ${byIdx.get(idx)!.address}  ${formatUnits(bal, 6)} USDC`);
  }
  console.log("");

  const results: RefundResult[] = [];

  for (const idx of ACTIVE_IDX) {
    const w = byIdx.get(idx)!;
    let bearer: string;
    try {
      ({ bearer } = await loginWallet(API, MNEMONIC, idx));
    } catch (err) {
      console.log(`  ! idx${idx} ${IDX_NAME[idx]} login FAILED: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const walletClient = makeAgentWalletClient({
      privateKey: w.privateKey, chainId: CHAIN_ID, rpcUrl: RPC,
    });

    for (const q of QUESTIONS) {
      let draft;
      try {
        draft = await fetchWithdrawDraft(API, bearer, q, w.address);
      } catch (err) {
        console.log(`  ! ${q} fetch draft failed for idx${idx}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const items = draft.eligible ?? [];
      if (items.length === 0) continue;

      for (const item of items) {
        if (item.actionType !== "refund" || !item.refund) continue;
        const r = item.refund;
        const tmplToken = (r.envelopeTemplate as any)?.envelope?.funds?.token as string | undefined;
        const tokenToUse = (tmplToken && tmplToken.toLowerCase() !== ZERO_ADDR) ? (tmplToken as Address) : USDC;
        const amount = BigInt(r.expectedAmount);
        try {
          const flow = await runRefundFlow({
            signer: w.address,
            qid: r.qid as Hex,
            questionId: q,
            nonce: BigInt(r.nonce),
            // OVERRIDE: use anvil-future expiry, ignore draft's recommendedExpiresAt
            expiresAt,
            forgeAddress: FORGE,
            chainId: r.chainId ?? CHAIN_ID,
            token: tokenToUse,
            sourceIntentHash: r.sourceIntentHash as Hex,
            expectedAmount: amount,
            expectedStatus: r.expectedStatus,
            bearerToken: bearer,
            baseUrl: API,
            // DROP expectedIntentHash — we changed expiresAt + maybe token, so it would mismatch
            // backend will re-derive from the posted envelope
            walletClient,
            privateKey: w.privateKey,
          });
          await awaitReceipt(pub as any, flow.txHash!);
          results.push({
            question: q, agentIdx: idx, role: item.role,
            amount, status: "broadcast",
            txHash: flow.txHash, intentHash: flow.intentHash,
          });
          console.log(`  ✓ ${q.slice(0, 22)}.. idx${idx} ${IDX_NAME[idx].padEnd(8)} ${item.role.padEnd(14)} ${formatUnits(amount, 6)} USDC tx=${flow.txHash}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            question: q, agentIdx: idx, role: item.role,
            amount, status: "failed", error: msg,
          });
          console.log(`  ✗ ${q.slice(0, 22)}.. idx${idx} ${IDX_NAME[idx].padEnd(8)} ${item.role.padEnd(14)} OWED ${formatUnits(amount, 6)} USDC — ${msg.replace(/\n/g, " ").slice(0, 200)}`);
        }
      }
    }
  }

  console.log("");
  const forgePost = await balanceOf(pub, FORGE);
  const agentPost = new Map<number, bigint>();
  for (const idx of ACTIVE_IDX) agentPost.set(idx, await balanceOf(pub, byIdx.get(idx)!.address));

  // tally
  console.log("\n────────────────────────────────────────");
  console.log("  PER-AGENT WALLET Δ");
  console.log("────────────────────────────────────────");
  let totalAgentDelta = 0n;
  for (const idx of ACTIVE_IDX) {
    const d = agentPost.get(idx)! - agentPre.get(idx)!;
    totalAgentDelta += d;
    console.log(`  idx${idx} ${IDX_NAME[idx].padEnd(8)} pre=${formatUnits(agentPre.get(idx)!, 6).padStart(12)}  post=${formatUnits(agentPost.get(idx)!, 6).padStart(12)}  Δ=${(d >= 0n ? "+" : "") + formatUnits(d, 6)} USDC`);
  }

  console.log("\n────────────────────────────────────────");
  console.log("  PER-QUESTION TALLY");
  console.log("────────────────────────────────────────");
  for (const q of QUESTIONS) {
    const rs = results.filter(r => r.question === q);
    if (rs.length === 0) continue;
    const ok = rs.filter(r => r.status === "broadcast");
    const fail = rs.filter(r => r.status === "failed");
    const amt = ok.reduce((s, r) => s + r.amount, 0n);
    console.log(`  ${q}: ${ok.length} ok ${formatUnits(amt, 6)} USDC${fail.length > 0 ? ` | ${fail.length} failed` : ""}`);
  }

  console.log("\n────────────────────────────────────────");
  console.log("  CONSERVATION CHECK");
  console.log("────────────────────────────────────────");
  const totalBroadcast = results.filter(r => r.status === "broadcast").reduce((s, r) => s + r.amount, 0n);
  const forgeOut = forgePre - forgePost;
  console.log(`  forge mUSDC pre:           ${formatUnits(forgePre, 6).padStart(11)} USDC`);
  console.log(`  forge mUSDC post:          ${formatUnits(forgePost, 6).padStart(11)} USDC`);
  console.log(`  forge outflow:             ${formatUnits(forgeOut, 6).padStart(11)} USDC`);
  console.log(`  Σ agent Δ (inflow):        ${formatUnits(totalAgentDelta, 6).padStart(11)} USDC`);
  console.log(`  Σ broadcast amount:        ${formatUnits(totalBroadcast, 6).padStart(11)} USDC`);
  console.log(`  broadcast count:           ${results.filter(r => r.status === "broadcast").length}`);
  console.log(`  failure count:             ${results.filter(r => r.status === "failed").length}`);
  const ok = forgeOut === totalAgentDelta && forgeOut === totalBroadcast;
  if (ok) console.log(`\n  ✓ CONSERVATION: forge outflow == Σ agent inflow == Σ broadcast == ${formatUnits(forgeOut, 6)} USDC`);
  else {
    console.log(`\n  ✗ CONSERVATION mismatch:`);
    console.log(`     forge outflow:        ${forgeOut}`);
    console.log(`     Σ agent inflow:       ${totalAgentDelta}`);
    console.log(`     Σ broadcast amount:   ${totalBroadcast}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n[FAIL] ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
