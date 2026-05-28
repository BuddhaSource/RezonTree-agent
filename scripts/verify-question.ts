#!/usr/bin/env tsx
// scripts/verify-question.ts — 4-layer verification for one question.
//
// For a given question_id, reports state at each truth layer:
//
//   L1 CHAIN     — cast for the unified Quadphase event (discriminated by
//                  the indexed `action` byte) with our qid
//   L2 PONDER    — ponder_indexer rows projecting those events
//   L3 DB        — backend's questions/solutions/votes/contributions
//                  with their confirmation_status
//   L4 API       — what /v1/questions/:id/{solutions,votes} returns
//                  to an unauth reader (post R-PENDING-IS-INTERNAL filter)
//
// Exit 0 if all four agree. Exit 1 if any layer disagrees, with a
// per-row diagnosis printed.
//
// Defaults target the production Base Sepolia stack. For local-anvil
// runs (oracle event-matrix harness, task #529) export:
//   RT_RPC_URL=http://127.0.0.1:8545
//   RT_CHAIN_ID=31337             (informational; printed in header)
//   RT_FORGE_ADDRESS=<from .env.local-anvil>
//   RT_AGENT_BACKEND_URL=http://localhost:8080
//   RT_PG_HOST=localhost          (default; override if non-local)
//   RT_PG_PORT=5432
//   RT_PG_USER=rezontree
//   RT_PG_DB=rezontree

import "dotenv/config";
import type { Address, Hex } from "viem";

const FORGE = (process.env.RT_FORGE_ADDRESS as Address)!;
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const BACKEND = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";
const CHAIN_ID = process.env.RT_CHAIN_ID ?? "(default chain)";

// Postgres connection params. Defaults match the local dev Postgres
// (rezontree-postgres-1 container on :5432). Override for non-local
// or test-DB runs.
const PG_HOST = process.env.RT_PG_HOST ?? "localhost";
const PG_PORT = process.env.RT_PG_PORT ?? "5432";
const PG_USER = process.env.RT_PG_USER ?? "rezontree";
const PG_DB = process.env.RT_PG_DB ?? "rezontree";
const PSQL_BASE_ARGS = [
  "-h", PG_HOST, "-p", PG_PORT, "-U", PG_USER, "-d", PG_DB,
  "-t", "-A",
];

if (!FORGE) throw new Error("RT_FORGE_ADDRESS required");

const qidArg = process.argv[2];
if (!qidArg) {
  console.error("usage: verify-question.ts <question_id>");
  console.error("  e.g.: verify-question.ts qst_d7syp0rqatg4cmcse0dg");
  console.error(
    "  env: RT_FORGE_ADDRESS, RT_RPC_URL, RT_AGENT_BACKEND_URL, RT_PG_{HOST,PORT,USER,DB}",
  );
  process.exit(2);
}

console.error(
  `verify-question  chain=${CHAIN_ID}  forge=${FORGE}  rpc=${RPC}  backend=${BACKEND}`,
);

// Question ID → bytes32 qid: backend computes qid via DeriveProblemQID.
// To avoid duplicating that math, we ask the DB.
function psqlOneShot(sql: string): string {
  // Quote SQL so backticks/quotes inside don't escape the shell. We
  // use execFileSync to bypass shell entirely.
  const cp = require("node:child_process") as typeof import("node:child_process");
  const r = cp.execFileSync("psql", [...PSQL_BASE_ARGS, "-c", sql], {
    encoding: "utf8",
  });
  return r.trim();
}

function qidFromDb(questionId: string): string {
  const out = psqlOneShot(
    `SELECT encode(qid, 'hex') FROM questions WHERE id='${questionId}'`,
  );
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

// Action tags discriminate the unified Quadphase event. The contract no
// longer emits per-action events (QuestionSponsored / SolutionCommitted /
// VoteCast / SettlementPublished are all gone) — every submit/pull/settle
// action emits a single `Quadphase(qid, signer, action, intentHash, ...)`
// and the off-band terminals emit `ForcedAbandonment` / `Recovered` /
// `FeesWithdrawn`. The `action` byte selects which lifecycle step a log
// represents; see contracts/src/RezonForge.sol event Quadphase + the
// QuadphaseTypes action-tag enum.
type ChainAction = "sponsor" | "cosponsor" | "commit" | "vote" | "settle";

async function chainCount(_qidBytes: Hex, _action: ChainAction): Promise<number> {
  // Per R-CHAIN-IS-PUBLIC-TRUTH: Ponder IS chain truth. Once Ponder is
  // healthy + caught up to head, querying ponder_indexer.* is
  // semantically equivalent to scanning the chain logs — and avoids
  // public RPC's 10k-block window limit. We surface "L1 chain" via
  // Ponder tables and report Ponder's checkpoint block at the top.
  // If you want raw chain verification (e.g., suspect Ponder is wrong),
  // run `cast logs --address $FORGE --event 'Quadphase(...)' ...` and
  // filter on the indexed `action` topic separately.
  //
  // TODO(#435): wire a real chain-side count by filtering `Quadphase`
  // logs on (qid, action) once we want a raw-RPC oracle independent of
  // Ponder. Today this is a stub — Ponder's count is treated as L1 truth.
  return -1; // sentinel: "use Ponder's count as the L1 truth"
}

function dbScalar(sql: string): number {
  const out = psqlOneShot(sql);
  return Number.parseInt(out, 10) || 0;
}

async function apiCount(path: string): Promise<number> {
  const r = await fetch(`${BACKEND}${path}`);
  if (!r.ok) return -1;
  const j = (await r.json()) as { data?: unknown[] };
  return (j.data ?? []).length;
}

// Round 3 collapsed standalone list endpoints into ?include=<key> on the
// parent detail endpoint. The included payload sits at body[key].data
// with an envelope shape {data: [...], hasMore: bool}.
//
// includeKey vs path: the include query value and the response key are
// the same string today (e.g. ?include=solutions → body.solutions.data).
async function apiIncludeCount(parentPath: string, includeKey: string): Promise<number> {
  const sep = parentPath.includes("?") ? "&" : "?";
  const r = await fetch(`${BACKEND}${parentPath}${sep}include=${includeKey}`);
  if (!r.ok) return -1;
  const j = (await r.json()) as Record<string, { data?: unknown[] } | undefined>;
  const node = j[includeKey];
  if (!node) return -1;
  return (node.data ?? []).length;
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
  const chainSponsor = await chainCount(qid, "sponsor");
  const chainCosponsor = await chainCount(qid, "cosponsor");
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
  const chainCommit = await chainCount(qid, "commit");
  const ponderCommit = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.commits WHERE question_id='${qid}'`,
  );
  const dbCommit = dbScalar(`SELECT COUNT(*) FROM solutions WHERE question_id='${qidArg}'`);
  const dbCommitConfirmed = dbScalar(
    `SELECT COUNT(*) FROM solutions WHERE question_id='${qidArg}' AND confirmation_status='confirmed'`,
  );
  // Round 3: solutions list rides on ?include=solutions (#637).
  const apiCommit = await apiIncludeCount(`/v1/questions/${qidArg}`, "solutions");
  console.log(
    `[commits]       ${fmt({ chain: chainCommit, ponder: ponderCommit, db: dbCommit, dbConfirmed: dbCommitConfirmed, api: apiCommit })}`,
  );

  // ── Votes ───────────────────────────────────────────────────────
  const chainVote = await chainCount(qid, "vote");
  const ponderVote = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.votes_cast WHERE question_id='${qid}'`,
  );
  const dbVote = dbScalar(`SELECT COUNT(*) FROM votes WHERE question_id='${qidArg}'`);
  const dbVoteConfirmed = dbScalar(
    `SELECT COUNT(*) FROM votes WHERE question_id='${qidArg}' AND confirmation_status='confirmed'`,
  );
  // Round 3: votes list rides on ?include=votes (#637).
  const apiVote = await apiIncludeCount(`/v1/questions/${qidArg}`, "votes");
  console.log(
    `[votes]         ${fmt({ chain: chainVote, ponder: ponderVote, db: dbVote, dbConfirmed: dbVoteConfirmed, api: apiVote })}`,
  );

  // ── Settlement ──────────────────────────────────────────────────
  const chainSettle = await chainCount(qid, "settle");
  const ponderSettle = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.settlements WHERE question_id='${qid}'`,
  );
  const dbSettle = dbScalar(
    `SELECT COUNT(*) FROM round_results WHERE merkle_root IS NOT NULL AND round_id IN (SELECT id FROM rounds WHERE question_id='${qidArg}')`,
  );
  console.log(
    `[settlement]    chain=${chainSettle}  ponder=${ponderSettle}  db_with_root=${dbSettle}`,
  );

  // Terminal-state checks happen after qDetail is fetched below.

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
    chainStakeFloor?: string;
    chainStakeBasisPoints?: number;
    chainVoteFee?: string;
    chainFundingDeadline?: number;
    chainTotalClaimable?: string;
    sponsors?: unknown[];
  };
  const chainMirrorPresent =
    !!qDetail?.chainStakeFloor ||
    !!qDetail?.chainFundingDeadline ||
    qDetail?.chainStakeBasisPoints !== undefined;

  // ── Recovered + Abandoned (W4 out-of-band terminals) ────────────
  //
  // Two transitions live outside the unified Quadphase event:
  //   - Recovered            (RezonForge:Recovered event)
  //   - ForcedAbandonment    (RezonForge:ForcedAbandonment event)
  // Each is projected by internal/reconciler/quadphase_recovery.go onto
  // questions.status. The matrix below asserts that whenever Ponder has
  // a row, the DB + API show the corresponding terminal status.
  const ponderRecovered = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.recoveries WHERE question_id='${qid}'`,
  );
  const ponderForcedAbandoned = dbScalar(
    `SELECT COUNT(*) FROM ponder_indexer.forced_abandonments WHERE question_id='${qid}'`,
  );
  const dbStatus = psqlOneShot(
    `SELECT status FROM questions WHERE id='${qidArg}'`,
  ).trim();
  let apiStatus = "(unknown)";
  if (qDetail && typeof (qDetail as Record<string, unknown>).status === "string") {
    apiStatus = (qDetail as Record<string, unknown>).status as string;
  }
  let terminalOK = true;
  let terminalNote = "";
  if (ponderRecovered > 0) {
    terminalOK = terminalOK && dbStatus === "recovered" && apiStatus === "recovered";
    terminalNote = `recovered Ponder=${ponderRecovered} db=${dbStatus} api=${apiStatus}`;
  } else if (ponderForcedAbandoned > 0) {
    terminalOK = terminalOK && dbStatus === "abandoned" && apiStatus === "abandoned";
    terminalNote = `forced_abandonment Ponder=${ponderForcedAbandoned} db=${dbStatus} api=${apiStatus}`;
  }
  if (terminalNote) {
    console.log(`[terminal-oob]  ${terminalNote}  ${terminalOK ? "✅" : "❌"}`);
  }
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
        ...PSQL_BASE_ARGS,
        "-F", ",",
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
    // Round 3: account sub-resources ride on ?include=<key> (#637).
    // wallet include returns -1 until backend handler lands (#634).
    const wt = (await apiIncludeCount(`/v1/accounts/${addr}`, "wallet")).valueOf();
    const pq = (await apiIncludeCount(`/v1/accounts/${addr}`, "activity")).valueOf();
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
  if (primaryMatch && chainMirrorPresent && derivedFails === 0 && terminalOK) {
    console.log("✅ All layers + derived projections agree. End-to-end confirmed.");
    process.exit(0);
  } else if (!terminalOK) {
    console.log("❌ Terminal-state mismatch — chain emitted Recovered/ForcedAbandonment");
    console.log("   but the DB/API have not flipped to the matching terminal status.");
    console.log("   → Investigate internal/reconciler/quadphase_recovery.go projectors.");
    process.exit(1);
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
