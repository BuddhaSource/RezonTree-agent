#!/usr/bin/env tsx
// sweep-recoverable.ts — recovers funds from RezonForge for our 14 fleet wallets.
//
// RezonForge is admin-less by design: no emergencyWithdraw, no sweep. Every
// dollar leaves the contract only via an explicit per-recipient call. v2.9
// made all the relevant calls executor-callable, so a single operator wallet
// can pay gas and trigger redistribution to all fleet wallets.
//
// What this script does:
//   1. Walk DB resolved questions with stored merkle_leaves.
//      For each leaf whose recipient ∈ fleet, build a proof and call
//      `claimAllForQuestion(qid, recipient, amount, proof, 0, 0)`.
//   2. Walk DB abandoned questions where chain pool > 0.
//      For each fleet sponsor contribution, call `sponsorRefund(qid)`.
//      (One call per qid pays everyone proportionally — we dedupe by qid.)
//   3. For abandoned questions, also call `commitRefund` / `voteRefund` per
//      fleet intent_hash that has non-zero stake on chain.
//
// Usage:
//   pnpm tsx scripts/sweep-recoverable.ts                  # dry-run (default)
//   pnpm tsx scripts/sweep-recoverable.ts --execute        # broadcast
//
// Operator wallet (idx 0) pays gas. Funds flow to original recipients.

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  formatUnits,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import { Client as PgClient } from "pg";
import { hashLeaf, buildTreeLevels, merkleProof } from "../src/intents/merkle.js";
import { REZON_FORGE_ABI } from "../src/forge/abi.js";

const FORGE = (process.env.RT_FORGE_ADDRESS ??
  "0x89E8D5b1ABE6531577Aaf2611CF66fa01094e8F1") as Address;
const USDC = (process.env.RT_USDC_ADDRESS ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address;
const RPCS = (process.env.RT_RPC_URLS ?? "https://sepolia.base.org")
  .split(",")
  .map((s) => s.trim());
const M = process.env.RT_AGENT_MNEMONIC!;
const DB_URL =
  process.env.RT_DB_URL ?? "postgres://rezontree:rezontree@localhost:5432/rezontree";

// Use the canonical SDK ABI — its `questions()` getter has all 18 fields
// in declaration order. Hand-rolled tuples here decoded misaligned and
// surfaced as junk uint256s coerced via Number().
const FORGE_ABI = REZON_FORGE_ABI;

const STATUS_SETTLED = 2;
const STATUS_ABANDONED = 3;

function deriveFleet(): { idx: number; role: string; address: Address }[] {
  const roles = [
    "operator",
    "questioner-01",
    "questioner-02",
    "solver-02",
    "solver-03",
    "solver-04",
    "solver-05",
    "solver-06",
    "solver-07",
    "solver-08",
    "solver-09",
    "spare-11",
    "spare-12",
    "spare-13",
  ];
  return roles.map((role, idx) => {
    const a = mnemonicToAccount(M, { addressIndex: idx });
    return { idx, role, address: a.address.toLowerCase() as Address };
  });
}

interface PlanItem {
  kind: "claim" | "sponsorRefund" | "commitRefund" | "voteRefund";
  qid: Hex; // chain bytes32
  qstId: string; // app id, for logging
  recipient?: Address;
  amount?: bigint;
  proof?: Hex[];
  intentHash?: Hex;
  expectedUsdc?: bigint;
  reason?: string;
}

async function buildPlan(): Promise<PlanItem[]> {
  const fleet = deriveFleet();
  const fleetSet = new Set(fleet.map((w) => w.address));
  const pg = new PgClient({ connectionString: DB_URL });
  await pg.connect();
  const plan: PlanItem[] = [];

  // ── 1. Pool claims from resolved questions with stored merkle leaves
  const resolved = await pg.query(`
    SELECT q.id AS qst_id, encode(q.qid, 'hex') AS qid_hex, rr.merkle_leaves
    FROM round_results rr
    JOIN rounds r ON r.id = rr.round_id
    JOIN questions q ON q.id = r.question_id
    WHERE q.status = 'resolved' AND rr.merkle_leaves IS NOT NULL
  `);
  for (const row of resolved.rows) {
    const qid = ("0x" + row.qid_hex) as Hex;
    let leavesRaw = row.merkle_leaves;
    if (typeof leavesRaw === "string") {
      leavesRaw = JSON.parse(Buffer.from(leavesRaw, "base64").toString());
    }
    const leaves: { recipient: Address; amount: bigint }[] = leavesRaw.map(
      (l: any) => ({
        recipient: l.recipient.toLowerCase() as Address,
        amount: BigInt(l.amount),
      }),
    );
    const leafHashes = leaves.map((l) =>
      hashLeaf({ questionId: qid, recipient: l.recipient, amount: l.amount }),
    );
    for (let i = 0; i < leaves.length; i++) {
      if (!fleetSet.has(leaves[i].recipient)) continue;
      const proof = merkleProof(leafHashes, i);
      plan.push({
        kind: "claim",
        qid,
        qstId: row.qst_id,
        recipient: leaves[i].recipient,
        amount: leaves[i].amount,
        proof,
        expectedUsdc: leaves[i].amount,
      });
    }
  }

  // ── 2. Sponsor refunds — one per (qid) regardless of funder count.
  //      sponsorRefund() distributes to all funders pro-rata in one call.
  const abandoned = await pg.query(`
    SELECT DISTINCT q.id AS qst_id, encode(q.qid, 'hex') AS qid_hex
    FROM questions q
    JOIN rounds r ON r.question_id = q.id
    JOIN contributions c ON c.round_id = r.id
    WHERE q.status = 'abandoned'
      AND c.confirmation_status = 'confirmed'
      AND c.refunded_at IS NULL
      AND c.funder_address = ANY($1::bytea[])
  `, [fleet.map((w) => Buffer.from(w.address.slice(2), "hex"))]);
  for (const row of abandoned.rows) {
    plan.push({
      kind: "sponsorRefund",
      qid: ("0x" + row.qid_hex) as Hex,
      qstId: row.qst_id,
      reason: "abandoned question with un-refunded contribution",
    });
  }

  // ── 3. Stake refunds for abandoned questions — commit + vote refunds per intent
  const stakeRefunds = await pg.query(`
    SELECT 'commit' AS kind, encode(q.qid, 'hex') AS qid_hex, q.id AS qst_id,
           encode(s.intent_hash, 'hex') AS hash_hex, s.stake_amount
    FROM solutions s
    JOIN rounds r ON r.id = s.round_id
    JOIN questions q ON q.id = r.question_id
    WHERE q.status = 'abandoned' AND s.confirmation_status = 'confirmed'
      AND s.author_address = ANY($1::bytea[]) AND s.stake_claimed_at IS NULL
    UNION ALL
    SELECT 'vote', encode(q.qid, 'hex'), q.id,
           encode(v.intent_hash, 'hex'), v.stake_amount
    FROM votes v
    JOIN rounds r ON r.id = v.round_id
    JOIN questions q ON q.id = r.question_id
    WHERE q.status = 'abandoned' AND v.confirmation_status = 'confirmed'
      AND v.voter_address = ANY($1::bytea[]) AND v.stake_claimed_at IS NULL
  `, [fleet.map((w) => Buffer.from(w.address.slice(2), "hex"))]);
  for (const row of stakeRefunds.rows) {
    plan.push({
      kind: row.kind === "commit" ? "commitRefund" : "voteRefund",
      qid: ("0x" + row.qid_hex) as Hex,
      qstId: row.qst_id,
      intentHash: ("0x" + row.hash_hex) as Hex,
      expectedUsdc: BigInt(row.stake_amount),
    });
  }

  await pg.end();
  return plan;
}

// Filter plan items against current chain state to skip already-done work.
async function dryFilter(plan: PlanItem[], pub: ReturnType<typeof createPublicClient>): Promise<PlanItem[]> {
  const keep: PlanItem[] = [];
  // Group by qid for the question() reads
  const qids = [...new Set(plan.map((p) => p.qid))];
  const qstate = new Map<Hex, { status: number; poolAmount: bigint; abandoneligibleAt: bigint }>();
  for (const qid of qids) {
    try {
      const q = (await pub.readContract({
        address: FORGE,
        abi: FORGE_ABI as any,
        functionName: "questions",
        args: [qid],
      })) as readonly any[];
      // QuestionState tuple — see src/forge/abi.ts:265 for full field order.
      // poolAmount is index 15 (not 11; contract has 18 fields total).
      const status = Number(q[0]);
      const poolAmount = q[15] as bigint;
      let elig = 0n;
      try {
        elig = (await pub.readContract({
          address: FORGE,
          abi: FORGE_ABI as any,
          functionName: "getAbandonmentEligibleAt",
          args: [qid],
        })) as bigint;
      } catch {
        /* settled questions revert */
      }
      qstate.set(qid, { status, poolAmount, abandoneligibleAt: elig });
    } catch (e: any) {
      console.error(`  chain read failed for ${qid}: ${e?.shortMessage ?? e?.message}`);
    }
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const p of plan) {
    const s = qstate.get(p.qid);
    if (!s) continue;
    if (p.kind === "claim") {
      if (s.status !== STATUS_SETTLED) {
        p.reason = `skip: chain status=${s.status}, expected SETTLED`;
        continue;
      }
      keep.push(p);
    } else if (p.kind === "sponsorRefund") {
      if (s.status !== STATUS_ABANDONED) {
        p.reason = `skip: chain status=${s.status}, expected ABANDONED`;
        continue;
      }
      if (s.poolAmount === 0n) {
        p.reason = `skip: chain pool already 0 (already refunded)`;
        continue;
      }
      if (s.abandoneligibleAt > now) {
        p.reason = `skip: abandonment-grace not elapsed (${s.abandoneligibleAt - now}s remaining)`;
        continue;
      }
      keep.push(p);
    } else if (p.kind === "commitRefund" || p.kind === "voteRefund") {
      if (s.status !== STATUS_ABANDONED) {
        p.reason = `skip: chain status=${s.status}, expected ABANDONED`;
        continue;
      }
      if (s.abandoneligibleAt > now) {
        p.reason = `skip: abandonment-grace not elapsed (${s.abandoneligibleAt - now}s remaining)`;
        continue;
      }
      // Check on-chain stake still non-zero
      try {
        const stake = (await pub.readContract({
          address: FORGE,
          abi: FORGE_ABI as any,
          functionName: p.kind === "commitRefund" ? "solutionStake" : "voteStake",
          args: [p.intentHash!],
        })) as bigint;
        if (stake === 0n) {
          p.reason = `skip: stake already 0 (claimed)`;
          continue;
        }
      } catch {
        /* keep — let chain tell us */
      }
      keep.push(p);
    }
  }
  return keep;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const fleet = deriveFleet();
  const operator = fleet[0];
  const operatorAccount = mnemonicToAccount(M, { addressIndex: 0 });

  const pub = createPublicClient({
    chain: baseSepolia,
    transport: fallback(RPCS.map((url) => http(url, { batch: { batchSize: 100 } }))),
  });

  console.log(`Operator: ${operator.address} (idx 0)`);
  console.log(`Forge:    ${FORGE}`);
  console.log(`Mode:     ${execute ? "EXECUTE — will broadcast" : "DRY-RUN (use --execute to broadcast)"}`);
  console.log("");

  console.log("Building recovery plan from DB...");
  const rawPlan = await buildPlan();
  console.log(`  candidate items: ${rawPlan.length}`);

  console.log("Filtering against chain state...");
  const plan = await dryFilter(rawPlan, pub);
  console.log(`  actionable: ${plan.length} (${rawPlan.length - plan.length} skipped)`);
  console.log("");
  if (process.argv.includes("--verbose")) {
    console.log("Skipped (with reason):");
    const skipped = rawPlan.filter((p) => !plan.includes(p));
    const counts = new Map<string, number>();
    for (const p of skipped) {
      const k = `${p.kind}: ${p.reason ?? "unknown"}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(3)}x  ${k}`);
    }
    console.log("");
  }

  if (plan.length === 0) {
    console.log("Nothing to recover.");
    return;
  }

  const byKind = new Map<string, { count: number; usdc: bigint }>();
  for (const p of plan) {
    const cur = byKind.get(p.kind) ?? { count: 0, usdc: 0n };
    cur.count++;
    if (p.expectedUsdc) cur.usdc += p.expectedUsdc;
    byKind.set(p.kind, cur);
  }
  console.log("Plan summary:");
  for (const [k, v] of byKind) {
    console.log(`  ${k.padEnd(16)}  ${String(v.count).padStart(4)}x  ${formatUnits(v.usdc, 6).padStart(10)} USDC`);
  }
  console.log("");
  console.log("Items:");
  for (const p of plan) {
    const amt = p.expectedUsdc ? formatUnits(p.expectedUsdc, 6) + " USDC" : "—";
    const target = p.recipient ?? p.intentHash ?? "(per-qid)";
    console.log(`  ${p.kind.padEnd(16)} ${p.qstId} → ${target}  ${amt}`);
  }

  if (!execute) {
    console.log("");
    console.log("Dry-run complete. Re-run with --execute to broadcast.");
    return;
  }

  console.log("");
  console.log("Broadcasting...");
  const wallet = createWalletClient({
    chain: baseSepolia,
    transport: fallback(RPCS.map((url) => http(url))),
    account: operatorAccount,
  });

  let ok = 0;
  let fail = 0;
  for (const p of plan) {
    try {
      let txHash: Hex;
      if (p.kind === "claim") {
        txHash = await wallet.writeContract({
          address: FORGE,
          abi: FORGE_ABI as any,
          functionName: "claimAllForQuestion",
          args: [
            p.qid,
            p.recipient!,
            p.amount!,
            p.proof! as readonly Hex[],
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          ],
        });
      } else if (p.kind === "sponsorRefund") {
        txHash = await wallet.writeContract({
          address: FORGE,
          abi: FORGE_ABI as any,
          functionName: "sponsorRefund",
          args: [p.qid],
        });
      } else if (p.kind === "commitRefund") {
        txHash = await wallet.writeContract({
          address: FORGE,
          abi: FORGE_ABI as any,
          functionName: "commitRefund",
          args: [p.qid, p.intentHash!],
        });
      } else {
        txHash = await wallet.writeContract({
          address: FORGE,
          abi: FORGE_ABI as any,
          functionName: "voteRefund",
          args: [p.qid, p.intentHash!],
        });
      }
      console.log(`  ✓ ${p.kind} ${p.qstId}  tx=${txHash}`);
      await pub.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
      ok++;
    } catch (e: any) {
      console.log(`  ✗ ${p.kind} ${p.qstId}  ${e?.shortMessage ?? e?.message ?? e}`);
      fail++;
    }
  }
  console.log("");
  console.log(`Done: ${ok} ok, ${fail} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
