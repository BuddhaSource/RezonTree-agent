#!/usr/bin/env tsx
// scripts/assert-event-matrix.ts — 4-layer assertion harness for the
// oracle event-matrix simulator (task #529).
//
// Reads the run manifest produced by sim-event-matrix.ts and, for
// each submitted intent_hash, verifies it appears at all four truth
// layers:
//
//   L1 CHAIN  — the tx receipt log contains Quadphase(intentHash=...)
//   L2 PONDER — ponder_indexer.quadphase_events has the row
//   L3 DB     — the action's content table (solutions / votes /
//               contributions / round_results) has the row with
//               confirmation_status='confirmed'
//   L4 API    — GET /v1/questions/:id/<endpoint> includes the row
//
// Output: JSON matrix to stdout (and JSON to <runDir>/result.json).
// Exit non-zero if any cell fails.
//
// USAGE
// -----
//   npx tsx scripts/assert-event-matrix.ts --run-dir .matrix-run/<id>
//
// Defaults to .matrix-run/latest if --run-dir is omitted.

import "dotenv/config";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  http,
  parseAbi,
  decodeEventLog,
  type Address,
  type Hex,
} from "viem";

interface SubmittedIntent {
  action: string;
  intentHash?: Hex;
  txHash?: Hex;
  qid?: Hex;
  signer: Address;
  status: "ok" | "skipped" | "error";
  reason?: string;
}

interface Manifest {
  runId: string;
  chainId: number;
  rpcUrl: string;
  backendUrl: string;
  forgeAddress: Address;
  usdcAddress: Address;
  wallets: { sponsor: Address; solver: Address; voter: Address };
  submitted: SubmittedIntent[];
}

// Action → content table + L4 endpoint shape.
const ACTION_TABLE: Record<
  string,
  { table: string; endpoint?: (qid: string) => string }
> = {
  Sponsor: { table: "contributions", endpoint: (qid) => `/v1/questions/${qid}` },
  Cosponsor: { table: "contributions", endpoint: (qid) => `/v1/questions/${qid}` },
  Commit: { table: "solutions", endpoint: (qid) => `/v1/questions/${qid}/solutions` },
  Vote: { table: "votes", endpoint: (qid) => `/v1/questions/${qid}/votes` },
  Settle: { table: "round_results", endpoint: (qid) => `/v1/questions/${qid}/result` },
  Claim: { table: "claims", endpoint: (qid) => `/v1/questions/${qid}/claims` },
  Refund: { table: "refunds" },
  Abandon: { table: "rounds" },
};

const PG_HOST = process.env.RT_PG_HOST ?? "localhost";
const PG_PORT = process.env.RT_PG_PORT ?? "5432";
const PG_USER = process.env.RT_PG_USER ?? "rezontree";
const PG_DB = process.env.RT_PG_DB ?? "rezontree";
const PSQL = ["-h", PG_HOST, "-p", PG_PORT, "-U", PG_USER, "-d", PG_DB, "-t", "-A"];

function psql(sql: string): string {
  try {
    return execFileSync("psql", [...PSQL, "-c", sql], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function parseFlags(): { runDir: string } {
  let runDir: string | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--run-dir") runDir = process.argv[++i];
  }
  if (!runDir) {
    // Pick the most-recent .matrix-run/<id>.
    const root = join(process.cwd(), ".matrix-run");
    try {
      const entries = readdirSync(root).sort();
      if (entries.length === 0) throw new Error("no runs found");
      runDir = join(root, entries[entries.length - 1]);
    } catch (err) {
      console.error(
        "error: --run-dir omitted and .matrix-run/ has no entries.",
        err,
      );
      process.exit(2);
    }
  }
  return { runDir: runDir as string };
}

interface CellResult {
  ok: boolean;
  detail?: string;
}

interface RowResult {
  action: string;
  intentHash?: Hex;
  L1: CellResult;
  L2: CellResult;
  L3: CellResult;
  L4: CellResult;
}

async function assertL1Chain(
  rpcUrl: string,
  forgeAddress: Address,
  intentHash: Hex,
  txHash: Hex,
): Promise<CellResult> {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const receipt = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) return { ok: false, detail: "tx receipt not found" };
  if (receipt.status !== "success") return { ok: false, detail: `tx status=${receipt.status}` };

  const quadphaseAbi = parseAbi([
    "event Quadphase(bytes32 indexed qid, uint8 indexed actionTag, address indexed actor, bytes32 intentHash, bytes32 contentHash, uint256 nonce)",
  ]);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== forgeAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: quadphaseAbi,
        data: log.data,
        topics: log.topics,
      }) as { eventName: string; args: { intentHash: Hex } };
      if (
        decoded.eventName === "Quadphase" &&
        decoded.args.intentHash.toLowerCase() === intentHash.toLowerCase()
      ) {
        return { ok: true };
      }
    } catch {
      // wrong event signature; continue
    }
  }
  return { ok: false, detail: "no matching Quadphase log on receipt" };
}

function assertL2Ponder(intentHash: Hex): CellResult {
  const out = psql(
    `SELECT COUNT(*) FROM ponder_indexer.quadphase_events WHERE intent_hash = decode('${intentHash.slice(2)}', 'hex')`,
  );
  const n = Number.parseInt(out, 10);
  if (n > 0) return { ok: true };
  return { ok: false, detail: `ponder_indexer.quadphase_events: 0 rows for ${intentHash}` };
}

function assertL3Db(action: string, intentHash: Hex): CellResult {
  const spec = ACTION_TABLE[action];
  if (!spec) return { ok: false, detail: `no L3 spec for action=${action}` };
  // round_results don't carry a per-row intent_hash (settlement event
  // emits the question-scope merkle root, not a per-leaf intent).
  if (spec.table === "round_results") {
    return { ok: false, detail: "L3 settlement check needs question_id; populate manifest.qid" };
  }
  if (spec.table === "rounds") {
    return { ok: false, detail: "Abandon L3 check needs question_id; populate manifest.qid" };
  }
  const out = psql(
    `SELECT confirmation_status FROM ${spec.table} WHERE intent_hash = decode('${intentHash.slice(2)}', 'hex')`,
  );
  if (out === "confirmed") return { ok: true };
  if (out === "") return { ok: false, detail: `${spec.table}: no row for ${intentHash}` };
  return { ok: false, detail: `${spec.table}.confirmation_status=${out}` };
}

async function assertL4Api(
  backendUrl: string,
  action: string,
  qid: Hex | undefined,
  intentHash: Hex,
): Promise<CellResult> {
  const spec = ACTION_TABLE[action];
  if (!spec || !spec.endpoint) {
    return { ok: false, detail: `no L4 endpoint mapped for ${action}` };
  }
  if (!qid) return { ok: false, detail: "qid missing from manifest" };

  // The simulator records question_id (the app-level `qst_…` string),
  // which is what the API path expects. If the manifest only has the
  // bytes32 qid we'd need a lookup; skip for now and ask the
  // simulator to record both.
  const path = spec.endpoint(qid as unknown as string);
  const res = await fetch(`${backendUrl}${path}`);
  if (!res.ok) return { ok: false, detail: `${path} → ${res.status}` };
  const body = (await res.json()) as { data?: unknown };
  // Scan response JSON for the intentHash substring. Per-endpoint
  // shapes vary; this is good enough for a coarse assertion and we
  // refine per-action as the wiring lands.
  const json = JSON.stringify(body);
  if (json.toLowerCase().includes(intentHash.toLowerCase())) return { ok: true };
  return { ok: false, detail: `intent hash not present in ${path} response` };
}

async function main(): Promise<void> {
  const { runDir } = parseFlags();
  const manifest = JSON.parse(
    readFileSync(join(runDir, "manifest.json"), "utf8"),
  ) as Manifest;

  console.error(`assert-event-matrix  run_id=${manifest.runId}  dir=${runDir}`);

  const results: RowResult[] = [];
  for (const intent of manifest.submitted) {
    if (intent.status === "skipped" || !intent.intentHash || !intent.txHash) {
      results.push({
        action: intent.action,
        intentHash: intent.intentHash,
        L1: { ok: false, detail: intent.reason ?? "no intent recorded" },
        L2: { ok: false, detail: "skipped" },
        L3: { ok: false, detail: "skipped" },
        L4: { ok: false, detail: "skipped" },
      });
      continue;
    }
    const L1 = await assertL1Chain(
      manifest.rpcUrl,
      manifest.forgeAddress,
      intent.intentHash,
      intent.txHash,
    );
    const L2 = assertL2Ponder(intent.intentHash);
    const L3 = assertL3Db(intent.action, intent.intentHash);
    const L4 = await assertL4Api(
      manifest.backendUrl,
      intent.action,
      intent.qid,
      intent.intentHash,
    );
    results.push({ action: intent.action, intentHash: intent.intentHash, L1, L2, L3, L4 });
  }

  // Print compact table.
  console.log("\n=== 4-layer matrix ===");
  console.log(
    [
      "action".padEnd(11),
      "L1".padEnd(4),
      "L2".padEnd(4),
      "L3".padEnd(4),
      "L4".padEnd(4),
      "intent_hash",
    ].join("  "),
  );
  let anyFail = false;
  for (const r of results) {
    const cell = (c: CellResult) => (c.ok ? "✅" : "❌");
    if (!r.L1.ok || !r.L2.ok || !r.L3.ok || !r.L4.ok) anyFail = true;
    console.log(
      [
        r.action.padEnd(11),
        cell(r.L1).padEnd(4),
        cell(r.L2).padEnd(4),
        cell(r.L3).padEnd(4),
        cell(r.L4).padEnd(4),
        r.intentHash ?? "(skipped)",
      ].join("  "),
    );
  }

  // Verbose failure details.
  for (const r of results) {
    for (const [layer, cell] of [["L1", r.L1], ["L2", r.L2], ["L3", r.L3], ["L4", r.L4]] as const) {
      if (!cell.ok && cell.detail) {
        console.log(`  [${r.action}/${layer}] ${cell.detail}`);
      }
    }
  }

  writeFileSync(
    join(runDir, "result.json"),
    JSON.stringify({ runId: manifest.runId, results }, null, 2),
  );
  console.error(`\nwrote ${join(runDir, "result.json")}`);
  if (anyFail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
