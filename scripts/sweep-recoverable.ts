#!/usr/bin/env tsx
// sweep-recoverable.ts — recovers every recoverable dollar from RezonForge
// for the fleet wallets, across all questions they participated in.
//
// v1 → v2 shift (PURPOSE unchanged: pull back every claimable payout +
// every recoverable stake/sponsor refund for the fleet):
//   • v1 walked the DB itself to build per-leaf Merkle proofs and stake
//     lookups, then broadcast the REMOVED functions claimAllForQuestion /
//     sponsorRefund / commitRefund / voteRefund (+ read removed views
//     solutionStake / voteStake / getAbandonmentEligibleAt / questions()).
//   • v2 has ONE chain money-out door, pullValue, and ONE backend door
//     that enumerates everything a signer is owed on a question with
//     proofs/amounts/nonces pre-computed:
//       POST /v1/questions/:id/intents/preflight {actionType:"withdraw"}.
//     So this script's job shrinks to: (1) find the set of questions each
//     fleet wallet participated in (DB), (2) check each is in a money-out
//     state on-chain (getQuestionScalars: Settled / Abandoned / Recovered),
//     (3) call the withdraw door per (wallet, question) and sign+broadcast
//     each eligible claim/refund via runClaimFlow / runRefundFlow (shared
//     scripts/lib/operator-recovery.ts). The backend owns the merkle math
//     + slash/stake bookkeeping; the client only signs the canonical
//     envelope it returns (R-CLIENT-IS-TRUST-ORIGIN).
//
//   For Open-but-stalled questions past their recoverable wall, the v2
//   path is the permissionless `recover(qid)` (flips Open → Recovered),
//   after which contributors/stakers pull via the same refund door. This
//   script triggers recover(qid) when it sees a stalled-Open question the
//   fleet funded, then sweeps refunds on the next pass.
//
// Usage:
//   pnpm tsx scripts/sweep-recoverable.ts                  # dry-run (default)
//   pnpm tsx scripts/sweep-recoverable.ts --execute        # broadcast
//
// Operator wallet (idx 0) pays gas for recover(); each fleet wallet signs
// its own withdraw intents.

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import { Client as PgClient } from "pg";

import {
  buildWalletBank,
  loginWallet,
  sweepWalletQuestion,
  type DerivedWallet,
  type SweepOptions,
} from "./lib/operator-recovery.js";

const FORGE = (process.env.RT_FORGE_ADDRESS ??
  "0x89E8D5b1ABE6531577Aaf2611CF66fa01094e8F1") as Address;
const RPCS = (process.env.RT_RPC_URLS ?? process.env.RT_RPC_URL ?? "https://sepolia.base.org")
  .split(",")
  .map((s) => s.trim());
const M = process.env.RT_AGENT_MNEMONIC!;
const API_BASE = (process.env.RT_API_BASE ?? "http://localhost:8080").replace(/\/$/, "");
const CHAIN_ID = Number(process.env.RT_CHAIN_ID ?? "84532");
const BANK_SIZE = Number(process.env.RT_WALLET_BANK_SIZE ?? "14");
const DB_URL =
  process.env.RT_DB_URL ?? "postgres://rezontree:rezontree@localhost:5432/rezontree";

if (!M) {
  console.error("RT_AGENT_MNEMONIC required");
  process.exit(2);
}

// QuestionStatus enum (contracts/src/QuadphaseTypes.sol).
const STATUS_OPEN = 1;
const STATUS_SETTLED = 3;
const STATUS_ABANDONED = 4;
const STATUS_RECOVERED = 5;

// Minimal v2 read/recover ABI (the only chain surface this script needs).
const FORGE_V2_ABI = [
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
    name: "getQuestionTrust",
    stateMutability: "view",
    inputs: [{ name: "qid", type: "bytes32" }],
    outputs: [
      { name: "oracle", type: "address" },
      { name: "recoverableAt", type: "uint40" },
    ],
  },
  {
    type: "function",
    name: "recover",
    stateMutability: "nonpayable",
    inputs: [{ name: "qid", type: "bytes32" }],
    outputs: [],
  },
] as const;

interface FleetQuestion {
  qstId: string; // app id (qst_…)
  qid: Hex; // chain bytes32
  // fleet wallet addresses (lowercase) that participated on this question.
  participants: Set<string>;
}

/** Walk the DB for every question a fleet wallet touched (as
 *  contributor / solver / voter) that is in a terminal or
 *  recovery-eligible state. We don't try to compute amounts here — the
 *  withdraw door does that authoritatively. We only need the (question,
 *  participant) set so we know which doors to knock on. */
async function buildFleetQuestionSet(
  fleetAddrs: Address[],
): Promise<FleetQuestion[]> {
  const pg = new PgClient({ connectionString: DB_URL });
  await pg.connect();
  const byQid = new Map<string, FleetQuestion>();
  const fleetBytea = fleetAddrs.map((a) => Buffer.from(a.slice(2), "hex"));

  function note(qstId: string, qidHex: string, addrHex: string) {
    const qid = ("0x" + qidHex) as Hex;
    let row = byQid.get(qstId);
    if (!row) {
      row = { qstId, qid, participants: new Set() };
      byQid.set(qstId, row);
    }
    row.participants.add(("0x" + addrHex).toLowerCase());
  }

  try {
    // Contributions (sponsor / cosponsor) — recoverable on Abandoned /
    // Recovered, or claimable as winner-fee-share on Settled.
    const contribs = await pg.query(
      `SELECT q.id AS qst_id, encode(q.qid,'hex') AS qid_hex,
              encode(c.funder_address,'hex') AS addr_hex
         FROM contributions c
         JOIN rounds r ON r.id = c.round_id
         JOIN questions q ON q.id = r.question_id
        WHERE c.confirmation_status = 'confirmed'
          AND c.funder_address = ANY($1::bytea[])`,
      [fleetBytea],
    );
    for (const row of contribs.rows) note(row.qst_id, row.qid_hex, row.addr_hex);

    // Solutions (commit stake) — refund on Abandoned/Recovered, claim +
    // stake-back on Settled.
    const sols = await pg.query(
      `SELECT q.id AS qst_id, encode(q.qid,'hex') AS qid_hex,
              encode(s.author_address,'hex') AS addr_hex
         FROM solutions s
         JOIN rounds r ON r.id = s.round_id
         JOIN questions q ON q.id = r.question_id
        WHERE s.confirmation_status = 'confirmed'
          AND s.author_address = ANY($1::bytea[])`,
      [fleetBytea],
    );
    for (const row of sols.rows) note(row.qst_id, row.qid_hex, row.addr_hex);

    // Votes (vote stake/fee) — refund on Abandoned/Recovered, claim +
    // stake-back on Settled.
    const votes = await pg.query(
      `SELECT q.id AS qst_id, encode(q.qid,'hex') AS qid_hex,
              encode(v.voter_address,'hex') AS addr_hex
         FROM votes v
         JOIN rounds r ON r.id = v.round_id
         JOIN questions q ON q.id = r.question_id
        WHERE v.confirmation_status = 'confirmed'
          AND v.voter_address = ANY($1::bytea[])`,
      [fleetBytea],
    );
    for (const row of votes.rows) note(row.qst_id, row.qid_hex, row.addr_hex);
  } finally {
    await pg.end();
  }
  return [...byQid.values()];
}

async function main() {
  const execute = process.argv.includes("--execute");
  const verbose = process.argv.includes("--verbose");

  const bank = buildWalletBank(M, BANK_SIZE, CHAIN_ID);
  const fleet = [...bank.values()];
  const operator = fleet[0];
  const operatorAccount = mnemonicToAccount(M, { addressIndex: 0 });

  const pub = createPublicClient({
    chain: baseSepolia,
    transport: fallback(RPCS.map((url) => http(url, { batch: { batchSize: 100 } }))),
  });

  console.log(`Operator: ${operator.address} (idx 0)`);
  console.log(`Forge:    ${FORGE}`);
  console.log(`API:      ${API_BASE}`);
  console.log(`Mode:     ${execute ? "EXECUTE — will broadcast" : "DRY-RUN (use --execute to broadcast)"}`);
  console.log("");

  console.log("Building fleet question set from DB...");
  const questions = await buildFleetQuestionSet(fleet.map((w) => w.address));
  console.log(`  candidate questions: ${questions.length}`);

  // Read chain state per question once; classify into recover-trigger vs
  // sweepable vs skip.
  console.log("Classifying against chain state...");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const recoverTargets: FleetQuestion[] = [];
  const sweepTargets: FleetQuestion[] = [];
  for (const q of questions) {
    let status: number;
    let recoverableAt = 0n;
    try {
      const scalars = (await pub.readContract({
        address: FORGE,
        abi: FORGE_V2_ABI,
        functionName: "getQuestionScalars",
        args: [q.qid],
      })) as readonly [Address, number, bigint, boolean];
      status = Number(scalars[1]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (verbose) console.error(`  chain read failed for ${q.qstId}: ${msg.split("\n")[0]}`);
      continue;
    }
    if (status === STATUS_SETTLED || status === STATUS_ABANDONED || status === STATUS_RECOVERED) {
      sweepTargets.push(q);
    } else if (status === STATUS_OPEN) {
      // Maybe recoverable: read the recovery wall.
      try {
        const trust = (await pub.readContract({
          address: FORGE,
          abi: FORGE_V2_ABI,
          functionName: "getQuestionTrust",
          args: [q.qid],
        })) as readonly [Address, number | bigint];
        recoverableAt = BigInt(trust[1]);
      } catch {
        /* no trust window — not recoverable */
      }
      if (recoverableAt !== 0n && now >= recoverableAt) {
        recoverTargets.push(q);
      } else if (verbose) {
        const remaining = recoverableAt === 0n ? "no-wall" : `${recoverableAt - now}s`;
        console.log(`  skip ${q.qstId}: Open, recover wall ${remaining}`);
      }
    } else if (verbose) {
      console.log(`  skip ${q.qstId}: status=${status}`);
    }
  }
  console.log(`  recover()-eligible: ${recoverTargets.length}`);
  console.log(`  sweep-eligible:     ${sweepTargets.length}`);
  console.log("");

  if (recoverTargets.length === 0 && sweepTargets.length === 0) {
    console.log("Nothing to recover.");
    return;
  }

  // ── Phase 1: recover() stalled Open questions (operator pays gas) ──
  if (recoverTargets.length > 0) {
    console.log(`Phase 1 — recover() ${recoverTargets.length} stalled question(s):`);
    const opWallet = createWalletClient({
      chain: baseSepolia,
      transport: fallback(RPCS.map((url) => http(url))),
      account: operatorAccount,
    });
    for (const q of recoverTargets) {
      if (!execute) {
        console.log(`  DRY recover(${q.qstId})`);
        continue;
      }
      try {
        const tx = await opWallet.writeContract({
          address: FORGE,
          abi: FORGE_V2_ABI,
          functionName: "recover",
          args: [q.qid],
        });
        await pub.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
        console.log(`  ✓ recover(${q.qstId}) tx=${tx} — refunds now pullable; re-run to sweep`);
        // Once recovered, it's sweep-eligible on the NEXT run (refunds
        // open after the Recovered flip). Add to this run's sweep set too.
        sweepTargets.push(q);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  ✗ recover(${q.qstId}) ${msg.split("\n")[0].slice(0, 160)}`);
      }
    }
    console.log("");
  }

  // ── Phase 2: withdraw-door sweep for every (fleet wallet, question) ─
  console.log(`Phase 2 — withdraw-door sweep across ${sweepTargets.length} question(s):`);
  const sweepOpts: SweepOptions = {
    apiBase: API_BASE,
    forgeAddress: FORGE,
    rpcUrl: RPCS[0],
    chainId: CHAIN_ID,
    dryRun: !execute,
  };

  // Cache one bearer per wallet across all its questions.
  const bearers = new Map<number, string>();
  async function bearerFor(w: DerivedWallet): Promise<string | null> {
    const cached = bearers.get(w.index);
    if (cached) return cached;
    try {
      const { bearer } = await loginWallet(API_BASE, M, w.index);
      bearers.set(w.index, bearer);
      return bearer;
    } catch (e: unknown) {
      console.error(`  login idx=${w.index} failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  let totalWithdrawn = 0n;
  let totalItems = 0;
  let totalFailures = 0;
  for (const q of sweepTargets) {
    for (const addrLower of q.participants) {
      const w = bank.get(addrLower);
      if (!w) continue;
      const bearer = await bearerFor(w);
      if (!bearer) continue;
      const r = await sweepWalletQuestion(sweepOpts, w, bearer, q.qstId).catch((e: unknown) => {
        console.error(`  withdraw idx=${w.index} q=${q.qstId} failed: ${e instanceof Error ? e.message : e}`);
        return null;
      });
      if (!r || r.eligibleCount === 0) continue;
      totalWithdrawn += r.totalWithdrawnWei;
      totalFailures += r.failures;
      for (const item of r.items) {
        if (item.status === "broadcast") {
          totalItems++;
          console.log(
            `  ${execute ? "✓" : "DRY"} ${item.actionType.padEnd(6)} ${q.qstId} ${item.role.padEnd(14)} ` +
              `${formatUnits(item.amountWei, 6).padStart(10)} USDC → idx=${w.index}${item.txHash ? ` tx=${item.txHash}` : ""}`,
          );
        } else {
          console.log(`  ✗ ${item.actionType} ${q.qstId} idx=${w.index}: ${item.error}`);
        }
      }
    }
  }

  console.log("");
  console.log(
    `Done: ${totalItems} item(s) ${execute ? "broadcast" : "(dry-run)"}, ` +
      `${formatUnits(totalWithdrawn, 6)} USDC, ${totalFailures} failed.`,
  );
  if (!execute) console.log("Re-run with --execute to broadcast.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
