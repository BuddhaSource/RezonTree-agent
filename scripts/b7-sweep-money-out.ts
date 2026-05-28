// scripts/b7-sweep-money-out.ts — Drive winner-side claim + refund pulls
// across S1/S3/S4 (the fee-model B7 swarm's settled questions) for all 9
// active agents (idx 0-3, 4-5, 7-8). Reuses scripts/lib/operator-recovery.ts
// (the same sweepWalletQuestion that settle-and-claim + claim-sweep use).
//
// For each (agent × question) pair: login → withdraw preflight → for each
// eligible item, run pullValue (claim or refund) via runClaimFlow/
// runRefundFlow. Captures mUSDC wallet balance pre/post per agent and the
// forge contract balance pre/post. Final report: per-scenario tallies,
// per-agent deltas, aggregate, and conservation check.
//
// Honesty over green: failures are recorded with revert reason + envelope
// state, not swallowed.

import "dotenv/config";

import { createPublicClient, formatUnits, http, type Address, type Hex } from "viem";

import {
  buildWalletBank,
  loginWallet,
  sweepWalletQuestion,
  type DerivedWallet,
  type SweepOptions,
  type SweepWalletResult,
} from "./lib/operator-recovery.js";

const FORGE = (process.env.RT_FORGE_ADDRESS ?? "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9") as Address;
const USDC = (process.env.RT_USDC_ADDRESS ?? "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0") as Address;
const RPC = process.env.RT_RPC_URL ?? "http://localhost:8545";
const API = (process.env.RT_BACKEND_URL ?? process.env.RT_API_BASE ?? "http://localhost:8080").replace(/\/$/, "");
const CHAIN_ID = Number.parseInt(process.env.RT_CHAIN_ID ?? "31337", 10);
const MNEMONIC = process.env.RT_AGENT_MNEMONIC ?? "bulb excite inform release demand course team photo hobby wait vast please";

interface Scenario {
  name: string;
  questionId: string; // backend qst_ id (preflight resolves either form)
  qid: Hex; // bytes32 (informational)
}

const SCENARIOS: Scenario[] = [
  { name: "S1", questionId: "qst_d8bttx6hv72ae2j52t5g", qid: "0x0ec48109a7a1affc760e31e55a4f2a997f77b1a3b3b4987680836cf16f1f8a08" },
  { name: "S3", questionId: "qst_d8bv2x02fe5gtkyzxk1g", qid: "0xb65f1a39e89c1e06dca46fabce76af2cb1605f053387667d90994ff028db49bc" },
  { name: "S4", questionId: "qst_d8bvb0zk3k1a5v3eyj10", qid: "0xc56a351f26082fcaa30a86e73fe198b4053f50940b936912ffa4b3440c100507" },
];

// idx 0-3, 4-5, 7-8 — alice/bob/carol/dave/eve/frank/heidi/ivan
// (grace=idx6 unused, judy=idx9 unused)
const ACTIVE_IDX: number[] = [0, 1, 2, 3, 4, 5, 7, 8];
const IDX_NAME: Record<number, string> = {
  0: "alice", 1: "bob", 2: "carol", 3: "dave", 4: "eve", 5: "frank",
  6: "grace", 7: "heidi", 8: "ivan", 9: "judy",
};

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
] as const;

async function balanceOf(pub: ReturnType<typeof createPublicClient>, holder: Address): Promise<bigint> {
  return (await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [holder] })) as bigint;
}

interface AgentRecord {
  idx: number;
  name: string;
  address: Address;
  preBalance: bigint;
  postBalance: bigint;
  perScenario: Map<string, SweepWalletResult>;
}

async function main() {
  console.log("\n========================================================");
  console.log("  B7 MONEY-OUT SWEEP — winner-side pullValue across S1/S3/S4");
  console.log("========================================================");
  console.log(`  forge:   ${FORGE}`);
  console.log(`  mUSDC:   ${USDC}`);
  console.log(`  rpc:     ${RPC}  (chainId ${CHAIN_ID})`);
  console.log(`  backend: ${API}`);
  console.log(`  agents:  ${ACTIVE_IDX.map((i) => `idx${i}=${IDX_NAME[i]}`).join(", ")}`);
  console.log("");

  const pub = createPublicClient({ transport: http(RPC) });
  const bank = buildWalletBank(MNEMONIC, 10, CHAIN_ID); // size 10 → idx 0..9
  const byIdx = new Map<number, DerivedWallet>();
  for (const w of bank.values()) byIdx.set(w.index, w);

  // ── pre-sweep snapshot ───────────────────────────────────────────
  const forgePre = await balanceOf(pub, FORGE);
  console.log(`  forge mUSDC pre-sweep: ${formatUnits(forgePre, 6)} USDC (${forgePre} wei)`);
  const agents: AgentRecord[] = [];
  for (const idx of ACTIVE_IDX) {
    const w = byIdx.get(idx)!;
    const bal = await balanceOf(pub, w.address);
    agents.push({
      idx,
      name: IDX_NAME[idx],
      address: w.address,
      preBalance: bal,
      postBalance: 0n,
      perScenario: new Map(),
    });
    console.log(`    idx${idx} ${IDX_NAME[idx].padEnd(6)} ${w.address}  ${formatUnits(bal, 6)} USDC`);
  }
  console.log("");

  const sweepOpts: SweepOptions = {
    apiBase: API,
    forgeAddress: FORGE,
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    dryRun: false,
  };

  // ── sweep loop: per-agent login once, sweep each scenario ────────
  for (const rec of agents) {
    const w = byIdx.get(rec.idx)!;
    let bearer: string;
    try {
      ({ bearer } = await loginWallet(API, MNEMONIC, rec.idx));
    } catch (err) {
      console.log(`  ! idx${rec.idx} ${rec.name} login FAILED: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const s of SCENARIOS) {
      let result: SweepWalletResult;
      try {
        result = await sweepWalletQuestion(sweepOpts, w, bearer, s.questionId);
      } catch (err) {
        console.log(`  ! idx${rec.idx} ${rec.name} ${s.name} sweep error: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      rec.perScenario.set(s.name, result);
      if (result.eligibleCount === 0) {
        // silent — agent is owed nothing on this scenario
        continue;
      }
      for (const item of result.items) {
        const sign = item.status === "broadcast" ? "✓" : "✗";
        const amt = item.status === "broadcast"
          ? `${formatUnits(item.amountWei, 6)} USDC`
          : `OWED ${formatUnits(item.owedWei, 6)} USDC`;
        const tx = item.txHash ? ` tx=${item.txHash}` : "";
        const err = item.error ? ` — ${item.error.replace(/\n/g, " ").slice(0, 200)}` : "";
        console.log(`  ${sign} ${s.name} ${rec.name.padEnd(6)} ${item.actionType.padEnd(6)} ${item.role.padEnd(16)} ${amt}${tx}${err}`);
      }
    }
  }

  // ── post-sweep snapshot ──────────────────────────────────────────
  console.log("");
  const forgePost = await balanceOf(pub, FORGE);
  for (const rec of agents) {
    rec.postBalance = await balanceOf(pub, rec.address);
  }

  // ── per-scenario tally ───────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("  PER-SCENARIO TALLY (claim + refund)");
  console.log("────────────────────────────────────────");
  let aggClaim = 0n;
  let aggRefund = 0n;
  let aggClaimOwed = 0n;
  let aggRefundOwed = 0n;
  let aggBroadcastCount = 0;
  let aggFailureCount = 0;
  for (const s of SCENARIOS) {
    let claimAmt = 0n;
    let claimOwed = 0n;
    let claimItems = 0;
    let refundAmt = 0n;
    let refundOwed = 0n;
    let refundItems = 0;
    let scenarioFailures = 0;
    for (const rec of agents) {
      const r = rec.perScenario.get(s.name);
      if (!r) continue;
      for (const item of r.items) {
        if (item.status === "broadcast") {
          if (item.actionType === "claim") {
            claimAmt += item.amountWei;
            claimItems++;
          } else {
            refundAmt += item.amountWei;
            refundItems++;
          }
        } else {
          scenarioFailures++;
          if (item.actionType === "claim") claimOwed += item.owedWei;
          else refundOwed += item.owedWei;
        }
        if (item.actionType === "claim") claimOwed += 0n; // owed already covered above on failure; broadcast-success owed not double-counted
      }
    }
    aggClaim += claimAmt;
    aggRefund += refundAmt;
    aggClaimOwed += claimOwed;
    aggRefundOwed += refundOwed;
    aggBroadcastCount += claimItems + refundItems;
    aggFailureCount += scenarioFailures;
    console.log(`  ${s.name}: ${claimItems} claim(s) ${formatUnits(claimAmt, 6)} USDC | ${refundItems} refund(s) ${formatUnits(refundAmt, 6)} USDC | failures=${scenarioFailures}${claimOwed > 0n || refundOwed > 0n ? ` (owed-not-pulled claim=${formatUnits(claimOwed, 6)} refund=${formatUnits(refundOwed, 6)})` : ""}`);
  }

  // ── per-agent wallet delta ───────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("  PER-AGENT WALLET Δ (mUSDC inflow)");
  console.log("────────────────────────────────────────");
  let totalAgentDelta = 0n;
  for (const rec of agents) {
    const delta = rec.postBalance - rec.preBalance;
    totalAgentDelta += delta;
    console.log(`  idx${rec.idx} ${rec.name.padEnd(6)} ${rec.address}  pre=${formatUnits(rec.preBalance, 6).padStart(11)}  post=${formatUnits(rec.postBalance, 6).padStart(11)}  Δ=${(delta >= 0n ? "+" : "") + formatUnits(delta, 6)} USDC`);
  }

  // ── conservation check ──────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("  CONSERVATION CHECK");
  console.log("────────────────────────────────────────");
  const forgeDelta = forgePost - forgePre; // negative = outflow
  const forgeOutflow = -forgeDelta;
  console.log(`  forge mUSDC pre:           ${formatUnits(forgePre, 6).padStart(11)} USDC`);
  console.log(`  forge mUSDC post:          ${formatUnits(forgePost, 6).padStart(11)} USDC`);
  console.log(`  forge outflow:             ${formatUnits(forgeOutflow, 6).padStart(11)} USDC`);
  console.log(`  Σ agent Δ (inflow):        ${formatUnits(totalAgentDelta, 6).padStart(11)} USDC`);
  console.log(`  Σ broadcast amount:        ${formatUnits(aggClaim + aggRefund, 6).padStart(11)} USDC  (claim=${formatUnits(aggClaim, 6)} + refund=${formatUnits(aggRefund, 6)})`);
  console.log(`  broadcast count:           ${aggBroadcastCount}`);
  console.log(`  failure count:             ${aggFailureCount}${aggClaimOwed > 0n || aggRefundOwed > 0n ? ` (owed-not-pulled: claim=${formatUnits(aggClaimOwed, 6)} refund=${formatUnits(aggRefundOwed, 6)})` : ""}`);
  console.log("");
  const conservationOk = forgeOutflow === totalAgentDelta && forgeOutflow === aggClaim + aggRefund;
  if (conservationOk) {
    console.log(`  ✓ CONSERVATION: forge outflow == Σ agent inflow == Σ broadcast amount == ${formatUnits(forgeOutflow, 6)} USDC`);
  } else {
    console.log(`  ✗ CONSERVATION mismatch — investigate`);
    console.log(`     forge outflow:        ${forgeOutflow}`);
    console.log(`     Σ agent inflow:       ${totalAgentDelta}`);
    console.log(`     Σ broadcast amount:   ${aggClaim + aggRefund}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n[FAIL] ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
