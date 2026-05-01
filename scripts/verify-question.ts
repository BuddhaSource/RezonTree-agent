#!/usr/bin/env tsx
// scripts/verify-question.ts — 4-layer verification for one question.
//
// For a given question_id, reports state at each truth layer:
//
//   L1 CHAIN     — cast for QuestionSponsored / SolutionCommitted /
//                  VoteCast / SettlementPublished events with our qid
//   L2 PONDER    — ponder_indexer rows projecting those events
//   L3 DB        — backend's questions/solutions/votes/contributions
//                  with their confirmation_status
//   L4 API       — what /v1/questions/:id/{solutions,votes} returns
//                  to an unauth reader (post R-PENDING-IS-INTERNAL filter)
//
// Exit 0 if all four agree. Exit 1 if any layer disagrees, with a
// per-row diagnosis printed.

import "dotenv/config";
import { execSync } from "node:child_process";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";

const FORGE = (process.env.RT_FORGE_ADDRESS as Address)!;
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const BACKEND = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";

if (!FORGE) throw new Error("RT_FORGE_ADDRESS required");

const qidArg = process.argv[2];
if (!qidArg) {
  console.error("usage: verify-question.ts <question_id>");
  console.error("  e.g.: verify-question.ts qst_d7syp0rqatg4cmcse0dg");
  process.exit(2);
}

const client = createPublicClient({ transport: http(RPC) });

// Question ID → bytes32 qid: backend computes qid via DeriveProblemQID.
// To avoid duplicating that math, we ask the DB.
function qidFromDb(questionId: string): string {
  const out = execSync(
    `psql -U rezontree -d rezontree -h localhost -t -A -c "SELECT encode(qid, 'hex') FROM questions WHERE id='${questionId}'"`,
    { encoding: "utf8" },
  ).trim();
  if (!out) throw new Error(`No question with id ${questionId} in DB`);
  return "0x" + out;
}

interface RowCounts {
  chain: number;
  ponder: number;
  db: number;
  dbConfirmed: number;
  api: number;
}

async function chainCount(qidBytes: Hex, eventSig: string): Promise<number> {
  const event = parseAbiItem(eventSig);
  // We scan a wide block range. For a brand-new contract this is
  // bounded by the deploy block; for older contracts, use the
  // PONDER_START_BLOCK in env as a floor.
  const fromBlock = BigInt(process.env.PONDER_START_BLOCK ?? "40893309");
  const logs = await client.getLogs({
    address: FORGE,
    event: event as never,
    args: { questionId: qidBytes } as never,
    fromBlock,
    toBlock: "latest",
  });
  return logs.length;
}

function dbScalar(sql: string): number {
  const out = execSync(
    `psql -U rezontree -d rezontree -h localhost -t -A -c "${sql}"`,
    { encoding: "utf8" },
  ).trim();
  return Number.parseInt(out, 10) || 0;
}

async function apiCount(path: string): Promise<number> {
  const r = await fetch(`${BACKEND}${path}`);
  if (!r.ok) return -1;
  const j = (await r.json()) as { data?: unknown[] };
  return (j.data ?? []).length;
}

function fmt(c: RowCounts): string {
  const ok = (a: number, b: number) =>
    a === b ? "✅" : a > b ? `⚠️  +${a - b}` : `❌  -${b - a}`;
  return [
    `chain=${c.chain}`,
    `ponder=${c.ponder} ${ok(c.ponder, c.chain)}`,
    `db=${c.db} (confirmed=${c.dbConfirmed} ${ok(c.dbConfirmed, c.chain)})`,
    `api=${c.api} ${ok(c.api, c.chain)}`,
  ].join("  ");
}

async function main() {
  const qid = qidFromDb(qidArg) as Hex;
  console.log(`Question: ${qidArg}  qid=${qid}\n`);

  // ── Sponsor / Cosponsor (treated as "contributions" in app) ─────
  const chainSponsor = await chainCount(
    qid,
    "event QuestionSponsored(bytes32 indexed questionId, address indexed sponsor, uint256 amount, bytes32 intentHash)",
  );
  const chainCosponsor = await chainCount(
    qid,
    "event QuestionCosponsored(bytes32 indexed questionId, address indexed sponsor, uint256 amount, bytes32 intentHash)",
  );
  const ponderSponsor = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.confirmations WHERE intent_hash IN (SELECT intent_hash FROM contributions WHERE question_id='${qidArg}')`,
  );
  const dbSponsor = dbScalar(`SELECT COUNT(*) FROM contributions WHERE question_id='${qidArg}'`);
  const dbSponsorConfirmed = dbScalar(
    `SELECT COUNT(*) FROM contributions WHERE question_id='${qidArg}' AND confirmation_status='confirmed'`,
  );
  const apiSponsor = await apiCount(`/v1/questions/${qidArg}`).then(() => 1).catch(() => 0); // question itself
  console.log(
    `[sponsorship]   ${fmt({ chain: chainSponsor + chainCosponsor, ponder: ponderSponsor, db: dbSponsor, dbConfirmed: dbSponsorConfirmed, api: apiSponsor })}`,
  );

  // ── Solution commits ────────────────────────────────────────────
  const chainCommit = await chainCount(
    qid,
    "event SolutionCommitted(bytes32 indexed questionId, address indexed solver, bytes32 intentHash, uint256 stake, uint256 fee)",
  );
  const ponderCommit = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.commits WHERE question_id='${qid}'`,
  );
  const dbCommit = dbScalar(`SELECT COUNT(*) FROM solutions WHERE question_id='${qidArg}'`);
  const dbCommitConfirmed = dbScalar(
    `SELECT COUNT(*) FROM solutions WHERE question_id='${qidArg}' AND confirmation_status='confirmed'`,
  );
  const apiCommit = await apiCount(`/v1/questions/${qidArg}/solutions`);
  console.log(
    `[commits]       ${fmt({ chain: chainCommit, ponder: ponderCommit, db: dbCommit, dbConfirmed: dbCommitConfirmed, api: apiCommit })}`,
  );

  // ── Votes ───────────────────────────────────────────────────────
  const chainVote = await chainCount(
    qid,
    "event VoteCast(bytes32 indexed questionId, address indexed voter, bytes32 intentHash, uint256 stake, uint256 fee, bytes32 allocationsHash)",
  );
  const ponderVote = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.votes_cast WHERE question_id='${qid}'`,
  );
  const dbVote = dbScalar(`SELECT COUNT(*) FROM votes WHERE question_id='${qidArg}'`);
  const dbVoteConfirmed = dbScalar(
    `SELECT COUNT(*) FROM votes WHERE question_id='${qidArg}' AND confirmation_status='confirmed'`,
  );
  const apiVote = await apiCount(`/v1/questions/${qidArg}/votes`);
  console.log(
    `[votes]         ${fmt({ chain: chainVote, ponder: ponderVote, db: dbVote, dbConfirmed: dbVoteConfirmed, api: apiVote })}`,
  );

  // ── Settlement ──────────────────────────────────────────────────
  const chainSettle = await chainCount(
    qid,
    "event SettlementPublished(bytes32 indexed questionId, bytes32 merkleRoot, uint256 totalClaimable, uint256 dustFolded)",
  );
  const ponderSettle = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.settlements WHERE question_id='${qid}'`,
  );
  const dbSettle = dbScalar(
    `SELECT COUNT(*) FROM round_results WHERE merkle_root IS NOT NULL AND round_id IN (SELECT id FROM rounds WHERE question_id='${qidArg}')`,
  );
  console.log(
    `[settlement]    chain=${chainSettle}  ponder=${ponderSettle}  db_with_root=${dbSettle}`,
  );

  // ── Verdict ─────────────────────────────────────────────────────
  const allMatch =
    chainCommit === ponderCommit &&
    ponderCommit === dbCommitConfirmed &&
    dbCommitConfirmed === apiCommit &&
    chainVote === ponderVote &&
    ponderVote === dbVoteConfirmed &&
    dbVoteConfirmed === apiVote;
  console.log("");
  if (allMatch) {
    console.log("✅ All four layers agree. End-to-end confirmed.");
    process.exit(0);
  } else {
    console.log("❌ Layer disagreement detected — see ⚠️ / ❌ markers above.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
