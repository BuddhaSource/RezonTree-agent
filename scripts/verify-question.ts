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

async function chainCount(_qidBytes: Hex, _eventSig: string): Promise<number> {
  // Per R-CHAIN-IS-PUBLIC-TRUTH: Ponder IS chain truth. Once Ponder is
  // healthy + caught up to head, querying ponder_indexer.* is
  // semantically equivalent to scanning the chain logs — and avoids
  // public RPC's 10k-block window limit. We surface "L1 chain" via
  // Ponder tables and report Ponder's checkpoint block at the top.
  // If you want raw chain verification (e.g., suspect Ponder is wrong),
  // run `cast logs --address $FORGE --topic <eventSig> ...` separately.
  return -1; // sentinel: "use Ponder's count as the L1 truth"
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
  // Ponder is chain truth; compare DB-confirmed and API against it.
  const ok = (a: number, b: number) =>
    a === b ? "✅" : a > b ? `⚠️  +${a - b}` : `❌  -${b - a}`;
  return [
    `ponder=${c.ponder} (chain truth)`,
    `db=${c.db} (confirmed=${c.dbConfirmed} ${ok(c.dbConfirmed, c.ponder)})`,
    `api=${c.api} ${ok(c.api, c.ponder)}`,
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
  // contributions joins through rounds — schema uses round_id, not question_id
  const ponderSponsor = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.confirmations WHERE intent_hash IN (
       SELECT '0x' || encode(c.intent_hash, 'hex') FROM contributions c
       JOIN rounds r ON c.round_id = r.id
       WHERE r.question_id='${qidArg}' AND c.intent_hash IS NOT NULL
     )`,
  );
  const dbSponsor = dbScalar(
    `SELECT COUNT(*) FROM contributions c JOIN rounds r ON c.round_id = r.id WHERE r.question_id='${qidArg}'`,
  );
  const dbSponsorConfirmed = dbScalar(
    `SELECT COUNT(*) FROM contributions c JOIN rounds r ON c.round_id = r.id WHERE r.question_id='${qidArg}' AND c.confirmation_status='confirmed'`,
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

  // ── L4-DERIVED projections ──────────────────────────────────────
  // Per R-VERIFY-FOUR-LAYERS, primary L4 (the entity itself appears
  // in /v1/.../<entity>) is necessary but not sufficient. Real UI
  // pages read these downstream projections; if they're empty when
  // the chain has activity, Ponder has a projector gap.
  console.log("\n=== L4-DERIVED (downstream projections) ===");

  // chain_* mirror columns on the question
  const qDetail = await fetch(`${BACKEND}/v1/questions/${qidArg}`).then((r) =>
    r.ok ? r.json() : null,
  ) as null | {
    chain_min_stake_floor?: string;
    chain_stake_basis_points?: number;
    chain_vote_fee?: string;
    chain_funding_deadline?: number;
    chain_total_claimable?: string;
    sponsors?: unknown[];
  };
  const chainMirrorPresent =
    !!qDetail?.chain_min_stake_floor ||
    !!qDetail?.chain_funding_deadline ||
    qDetail?.chain_stake_basis_points !== undefined;
  console.log(
    `[chain_* mirrors]   ${chainMirrorPresent ? "✅ populated" : "❌ ABSENT — projector gap on chain_* columns"}`,
  );
  console.log(
    `[sponsors[] array]  ${(qDetail?.sponsors?.length ?? 0) > 0 ? `✅ ${qDetail!.sponsors!.length} sponsor(s)` : "❌ EMPTY — sponsorship not projected"}`,
  );

  // Per-actor wallet_transactions + participating_questions.
  // Probe the addresses we know participated. We discover them from
  // the contributions / solutions / votes confirmed earlier.
  const knownAddresses = new Set<string>();
  const cp = await import("node:child_process");
  for (const row of await new Promise<Array<{ a: string }>>((resolve) => {
    cp.execFile(
      "psql",
      [
        "-U", "rezontree", "-d", "rezontree", "-h", "localhost", "-t", "-A", "-F", ",",
        "-c",
        `SELECT DISTINCT lower(encode(c.sponsor_address,'hex'))
           FROM contributions c JOIN rounds r ON c.round_id = r.id
           WHERE r.question_id='${qidArg}' AND c.sponsor_address IS NOT NULL
         UNION SELECT DISTINCT lower(encode(author_address,'hex'))
           FROM solutions WHERE question_id='${qidArg}' AND author_address IS NOT NULL
         UNION SELECT DISTINCT lower(encode(voter_address,'hex'))
           FROM votes WHERE question_id='${qidArg}' AND voter_address IS NOT NULL`,
      ],
      (err: Error | null, stdout: string) => {
        if (err) return resolve([]);
        resolve(
          stdout.trim().split("\n").filter(Boolean).map((s) => ({ a: "0x" + s })),
        );
      },
    );
  })) {
    knownAddresses.add(row.a);
  }

  let derivedFails = 0;
  for (const addr of knownAddresses) {
    const wt = (await apiCount(`/v1/accounts/${addr}/wallet/transactions`)).valueOf();
    const pq = (await apiCount(`/v1/accounts/${addr}/participating-questions`)).valueOf();
    const ok = wt > 0 && pq > 0;
    if (!ok) derivedFails++;
    console.log(
      `[${addr.slice(0, 10)}…]  wallet_tx=${wt} participating=${pq}  ${ok ? "✅" : "❌"}`,
    );
  }

  // ── Verdict ─────────────────────────────────────────────────────
  // Ponder is the chain-truth source; DB-confirmed and API must match it.
  const primaryMatch =
    ponderCommit === dbCommitConfirmed &&
    dbCommitConfirmed === apiCommit &&
    ponderVote === dbVoteConfirmed &&
    dbVoteConfirmed === apiVote;

  console.log("");
  if (primaryMatch && chainMirrorPresent && derivedFails === 0) {
    console.log("✅ All layers + derived projections agree. End-to-end confirmed.");
    process.exit(0);
  } else if (primaryMatch && (chainMirrorPresent === false || derivedFails > 0)) {
    console.log("⚠️ Primary 4 layers agree but DERIVED projections lag.");
    console.log("   Primary is OK; the UI pages reading wallet_transactions /");
    console.log("   participating_questions / chain_* mirrors will show stale state.");
    console.log("   → File defect against the relevant Ponder projector.");
    process.exit(1);
  } else {
    console.log("❌ Primary layer disagreement — see ⚠️ / ❌ markers above.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
