// tally-chain-events.ts — L1 source-of-truth enumerator.
//
// Pulls EVERY RezonForge event from live RPC (Quadphase + FeesWithdrawn +
// ForcedAbandonment + Recovered), decodes, and groups by qid into a case
// list. This is the chain side of an R-VERIFY-FOUR-LAYERS reconciliation:
// the chain is the independent oracle; the printed cases are then checked
// against the app DB (L3) + API (L4).
//
//   RT_FORGE_ADDRESS / FORGE_ADDRESS  contract address
//   FORGE_RPC_URL                      RPC (default Base Sepolia public)
//   FORGE_START_BLOCK                  scan start (default 40641510)
//   FORGE_CHUNK                        getLogs block chunk (default 50000)
//   TALLY_JSON=1                       emit machine-readable JSON too

import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

const FORGE = (process.env.RT_FORGE_ADDRESS ||
  process.env.FORGE_ADDRESS ||
  "0x5eb4Acdfd890bDd82D95fBd93339703E7879d5A7") as `0x${string}`;
const RPC = (process.env.FORGE_RPC_URL || "https://sepolia.base.org").split(",")[0].trim();
const START = BigInt(process.env.FORGE_START_BLOCK || "40641510");
let CHUNK = BigInt(process.env.FORGE_CHUNK || "50000");

const ACTION = ["sponsor", "cosponsor", "commit", "vote", "settle", "claim", "refund", "abandon"];
const STAKE_OP = ["none", "lock", "slash", "release"];

const quadphase = parseAbiItem(
  "event Quadphase(bytes32 indexed qid, address indexed signer, uint8 indexed action, bytes32 intentHash, bytes32 contentHash, uint256 nonce, uint256 expiresAt, uint256 poolIn, uint256 poolOut, uint256 feeAmount, uint256 stakeAmount, uint8 stakeOp)",
);
const feesWithdrawn = parseAbiItem(
  "event FeesWithdrawn(address indexed recipient, address indexed token, uint256 amount)",
);
const forcedAbandon = parseAbiItem(
  "event ForcedAbandonment(bytes32 indexed qid, address indexed caller, uint256 timestamp)",
);
const recovered = parseAbiItem("event Recovered(bytes32 indexed qid)");

const usdc = (v: bigint) => `$${formatUnits(v, 6)}`;

type Row = {
  block: bigint;
  tx: string;
  kind: string;
  qid?: string;
  signer?: string;
  action?: string;
  poolIn?: bigint;
  poolOut?: bigint;
  fee?: bigint;
  stake?: bigint;
  stakeOp?: string;
  intentHash?: string;
  recipient?: string;
  amount?: bigint;
};

async function getLogsChunked(client: any, event: any) {
  const head = await client.getBlockNumber();
  const out: any[] = [];
  let from = START;
  while (from <= head) {
    let to = from + CHUNK - 1n;
    if (to > head) to = head;
    try {
      const logs = await client.getLogs({ address: FORGE, event, fromBlock: from, toBlock: to });
      out.push(...logs);
      from = to + 1n;
    } catch (e: any) {
      // RPC range cap — halve and retry this window.
      if (CHUNK > 1000n) {
        CHUNK = CHUNK / 2n;
        process.stderr.write(`  (range cap hit; chunk→${CHUNK})\n`);
        continue;
      }
      throw e;
    }
  }
  return out;
}

async function main() {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const head = await client.getBlockNumber();
  process.stderr.write(`Scanning ${FORGE} blocks ${START}..${head} on ${RPC}\n`);

  const rows: Row[] = [];

  for (const l of await getLogsChunked(client, quadphase)) {
    const a = l.args;
    rows.push({
      block: l.blockNumber, tx: l.transactionHash, kind: "Quadphase",
      qid: a.qid, signer: a.signer, action: ACTION[Number(a.action)] ?? `?${a.action}`,
      poolIn: a.poolIn, poolOut: a.poolOut, fee: a.feeAmount, stake: a.stakeAmount,
      stakeOp: STAKE_OP[Number(a.stakeOp)] ?? `?${a.stakeOp}`, intentHash: a.intentHash,
    });
  }
  for (const l of await getLogsChunked(client, feesWithdrawn)) {
    const a = l.args;
    rows.push({ block: l.blockNumber, tx: l.transactionHash, kind: "FeesWithdrawn", recipient: a.recipient, amount: a.amount });
  }
  for (const l of await getLogsChunked(client, forcedAbandon)) {
    rows.push({ block: l.blockNumber, tx: l.transactionHash, kind: "ForcedAbandonment", qid: l.args.qid, signer: l.args.caller });
  }
  for (const l of await getLogsChunked(client, recovered)) {
    rows.push({ block: l.blockNumber, tx: l.transactionHash, kind: "Recovered", qid: l.args.qid });
  }

  rows.sort((x, y) => (x.block === y.block ? 0 : x.block < y.block ? -1 : 1));

  // ---- Global tally ----
  const byAction: Record<string, number> = {};
  for (const r of rows) {
    const k = r.kind === "Quadphase" ? `Quadphase:${r.action}` : r.kind;
    byAction[k] = (byAction[k] ?? 0) + 1;
  }
  console.log("\n=== GLOBAL TALLY ===");
  console.log(`total events: ${rows.length}`);
  for (const [k, n] of Object.entries(byAction).sort()) console.log(`  ${k.padEnd(22)} ${n}`);

  // ---- Per-qid case list ----
  const byQid = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.qid) continue;
    if (!byQid.has(r.qid)) byQid.set(r.qid, []);
    byQid.get(r.qid)!.push(r);
  }
  console.log(`\n=== CASE LIST (${byQid.size} questions) ===`);
  let i = 0;
  for (const [qid, evs] of byQid) {
    i++;
    const actions = evs.filter((e) => e.kind === "Quadphase").map((e) => e.action);
    const terminal = actions.includes("settle") ? "SETTLED" : actions.includes("abandon") ? "ABANDONED" : "OPEN/INCOMPLETE";
    console.log(`\n[${i}] qid=${qid}  → ${terminal}  (${evs.length} events)`);
    for (const e of evs) {
      if (e.kind === "Quadphase") {
        const econ = [
          e.poolIn ? `in=${usdc(e.poolIn)}` : "",
          e.poolOut ? `out=${usdc(e.poolOut)}` : "",
          e.fee ? `fee=${usdc(e.fee)}` : "",
          e.stake ? `stake=${usdc(e.stake)}/${e.stakeOp}` : "",
        ].filter(Boolean).join(" ");
        console.log(`    blk ${e.block}  ${e.action!.padEnd(9)} signer=${e.signer!.slice(0, 10)}  ${econ}  ih=${e.intentHash!.slice(0, 10)}`);
      } else {
        console.log(`    blk ${e.block}  ${e.kind}`);
      }
    }
  }

  // FeesWithdrawn are qid-less (recipient drains) — list separately.
  const fw = rows.filter((r) => r.kind === "FeesWithdrawn");
  if (fw.length) {
    console.log(`\n=== FeesWithdrawn (${fw.length}) — recipient drains, qid-less ===`);
    for (const e of fw) console.log(`    blk ${e.block}  recipient=${e.recipient}  amount=${usdc(e.amount!)}`);
  }

  if (process.env.TALLY_JSON === "1") {
    const ser = (r: Row) => ({ ...r, block: Number(r.block), poolIn: r.poolIn?.toString(), poolOut: r.poolOut?.toString(), fee: r.fee?.toString(), stake: r.stake?.toString(), amount: r.amount?.toString() });
    console.log("\n=== JSON ===");
    console.log(JSON.stringify(rows.map(ser), null, 0));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
