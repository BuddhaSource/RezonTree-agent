#!/usr/bin/env tsx
// _c-drain-to-zero.ts — swarm-run-3 PART C: drain RezonForge mUSDC to ZERO.
//
// CLOCK-SKEW AWARE (mirrors recover-anvil-refunds-v2): the B3 time-warp pushed
// anvil's block.timestamp ~2d ahead of host. The backend's withdraw preflight
// sets recommendedExpiresAt = host_now + 5min, which is in anvil's PAST, so a
// verbatim broadcast reverts `env:expired`. We override expiresAt = anvil_ts +
// 1h on every claim/refund envelope. The backend re-derives intent_hash from
// the POSTed envelope at Stage 2 (no upper-bound on expiresAt), and the chain
// accepts as long as expiresAt > block.timestamp.
//
// For EVERY question × EVERY fleet wallet (idx 0-9): fetch the withdraw draft,
// then for each eligible claim/refund item run runClaimFlow/runRefundFlow with
// the overridden expiresAt. Then withdrawFees(recipient) for platform + grace.
// Target: forge mUSDC == 0.

import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { SessionManager } from "../src/wallet/session.js";
import { makeAgentWalletClient, awaitReceipt } from "../src/forge/quadphase-broadcast.js";
import { runClaimFlow, runRefundFlow } from "../src/forge/quadphase-flow.js";
import { fetchWithdrawDraft, tokenFromTemplate } from "./lib/operator-recovery.js";
import { Client as PgClient } from "pg";

const API = (process.env.RT_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");
const RPC = process.env.RT_RPC_URL ?? "http://localhost:8545";
const FORGE = (process.env.RT_FORGE_ADDRESS ?? "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9") as Address;
const USDC = (process.env.RT_USDC_ADDRESS ?? "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0") as Address;
const CHAIN_ID = Number.parseInt(process.env.RT_CHAIN_ID ?? "31337", 10);
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const PG = process.env.DATABASE_URL ?? "postgres://rezontree:rezontree@localhost:5432/rezontree";
const OP_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const PLATFORM = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

const ERC20_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const FEE_ABI = [
  { name: "accruedFees", type: "function", stateMutability: "view", inputs: [{ name: "r", type: "address" }, { name: "t", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "withdrawFees", type: "function", stateMutability: "nonpayable", inputs: [{ name: "recipient", type: "address" }, { name: "tk", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
const chain = { id: CHAIN_ID, name: "anvil", nativeCurrency: { name: "eth", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

async function main() {
  const pub = createPublicClient({ transport: http(RPC) });
  const forgeBal = async () => (await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [FORGE] })) as bigint;

  const blk = await pub.getBlock();
  const anvilTs = Number(blk.timestamp);
  const expiresAt = BigInt(anvilTs + 3600);
  console.log(`\n=== PART C — DRAIN TO ZERO (clock-skew aware) ===`);
  console.log(`anvil block.timestamp=${anvilTs} (skew +${((anvilTs - Math.floor(Date.now()/1000))/86400).toFixed(2)}d); envelope.expiresAt=${expiresAt}`);
  console.log(`forge mUSDC pre-drain: ${formatUnits(await forgeBal(), 6)} (${await forgeBal()} wei)`);

  const pg = new PgClient({ connectionString: PG }); await pg.connect();
  const { rows } = await pg.query<{ id: string; status: string }>("SELECT id, status FROM questions ORDER BY created_at");
  await pg.end();

  const sessions = new SessionManager({ apiBase: API, domain: loadLoginDomain() });
  let totalPulled = 0n; const perAgent: Record<number, bigint> = {};

  for (let pass = 1; pass <= 2; pass++) {
    console.log(`\n--- sweep pass ${pass} ---`);
    for (let idx = 0; idx <= 9; idx++) {
      const w = deriveAgentWallet(MNEMONIC, idx, CHAIN_ID);
      let token: string;
      try { token = await sessions.ensureToken(w); } catch { continue; }
      const wc = makeAgentWalletClient({ privateKey: w.privateKey as Hex, chainId: CHAIN_ID, rpcUrl: RPC });
      for (const q of rows) {
        let draft: any;
        try { draft = await fetchWithdrawDraft(API, token, q.id, w.address as Address); } catch { continue; }
        for (const item of (draft.eligible ?? [])) {
          try {
            if (item.actionType === "claim" && item.claim) {
              const c = item.claim;
              // Claim is permissionless + unsigned — proof is the auth,
              // funds go to the leaf's recipient. No envelope / sig / POST.
              const res = await runClaimFlow({
                qid: c.qid as Hex, recipient: c.recipient as Address,
                forgeAddress: FORGE,
                proof: c.proof as Hex[], leafIndex: BigInt(c.leafIndex), leafAmount: BigInt(c.leafAmount),
                role: c.role, walletClient: wc,
              });
              await awaitReceipt(pub as any, res.txHash);
              const amt = BigInt(c.leafAmount); totalPulled += amt; perAgent[idx] = (perAgent[idx] ?? 0n) + amt;
              console.log(`  idx${idx} ${q.id.slice(0,12)} claim/${item.role}: ${formatUnits(amt,6)}`);
            } else if (item.actionType === "refund" && item.refund) {
              const rf = item.refund;
              const token0 = tokenFromTemplate(rf, "refund");
              const res = await runRefundFlow({
                signer: w.address as Address, qid: rf.qid as Hex, questionId: q.id,
                nonce: BigInt(rf.nonce), expiresAt, forgeAddress: FORGE, chainId: CHAIN_ID,
                token: token0, sourceIntentHash: rf.sourceIntentHash as Hex, expectedAmount: BigInt(rf.expectedAmount),
                expectedStatus: rf.expectedStatus, bearerToken: token, baseUrl: API, walletClient: wc, privateKey: w.privateKey as Hex,
              });
              await awaitReceipt(pub as any, res.txHash!);
              const amt = BigInt(rf.expectedAmount); totalPulled += amt; perAgent[idx] = (perAgent[idx] ?? 0n) + amt;
              console.log(`  idx${idx} ${q.id.slice(0,12)} refund/${item.role}: ${formatUnits(amt,6)}`);
            }
          } catch (e) { console.log(`  ! idx${idx} ${q.id.slice(0,12)} ${item.actionType}/${item.role}: ${(e as Error).message.split("\n")[0].slice(0,90)}`); }
        }
      }
    }
    console.log(`  forge after pass ${pass}: ${formatUnits(await forgeBal(), 6)}`);
  }

  console.log(`\n--- fee withdraws ---`);
  const op = createWalletClient({ account: privateKeyToAccount(OP_PK), transport: http(RPC), chain: chain as any });
  const grace = deriveAgentWallet(MNEMONIC, 7, CHAIN_ID).address as Address;
  for (const [name, recip] of [["platform", PLATFORM], ["grace", grace]] as [string, Address][]) {
    const accrued = (await pub.readContract({ address: FORGE, abi: FEE_ABI, functionName: "accruedFees", args: [recip, USDC] })) as bigint;
    if (accrued === 0n) { console.log(`  ${name}: 0 accrued — skip`); continue; }
    try {
      const tx = await op.writeContract({ address: FORGE, abi: FEE_ABI, functionName: "withdrawFees", args: [recip, USDC] });
      await pub.waitForTransactionReceipt({ hash: tx });
      console.log(`  ✓ withdrawFees(${name}) pulled ${formatUnits(accrued,6)}`); totalPulled += accrued;
    } catch (e) { console.log(`  ✗ withdrawFees(${name}): ${(e as Error).message.split("\n")[0]}`); }
  }

  const finalBal = await forgeBal();
  console.log(`\n=== DRAIN RESULT ===`);
  console.log(`total pulled: ${formatUnits(totalPulled, 6)} mUSDC`);
  console.log(`forge mUSDC FINAL: ${formatUnits(finalBal, 6)} (${finalBal} wei)`);
  console.log(finalBal === 0n ? "✓✓✓ FORGE DRAINED TO ZERO" : `! RESIDUAL ${finalBal} wei`);
  for (const [idx, amt] of Object.entries(perAgent).sort()) console.log(`  idx${idx} pulled ${formatUnits(amt,6)}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
