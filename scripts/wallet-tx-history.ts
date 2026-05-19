#!/usr/bin/env tsx
// wallet-tx-history.ts — Per-wallet USDC ledger from chain, reconciled against DB.
//
// Walks USDC Transfer logs on Base Sepolia for all 14 HD-derived wallets
// (idx 0-13) over a configurable block range. Classifies each transfer by
// counterparty (Forge contract / sibling wallet / external) and, where the
// counterparty is the Forge, cross-references signed_intents by tx hash to
// label the protocol action.
//
// DB reset note: rows in signed_intents only go back to ~2026-05-06. Older
// chain activity is shown as "chain-only" with no DB enrichment.
//
// Usage:
//   pnpm tsx scripts/wallet-tx-history.ts                # last 30 days
//   pnpm tsx scripts/wallet-tx-history.ts --from 40500000 # since block
//   pnpm tsx scripts/wallet-tx-history.ts --csv > out.csv # csv export
//
// Reads env: RT_AGENT_MNEMONIC, RT_USDC_ADDRESS, RT_FORGE_ADDRESS,
//            RT_RPC_URLS (comma-separated), RT_DB_URL (optional)

import "dotenv/config";
import {
  createPublicClient,
  http,
  parseAbiItem,
  formatUnits,
  fallback,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import { Client as PgClient } from "pg";

const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FORGE = (
  (process.env.RT_FORGE_ADDRESS ??
    "0x89E8D5b1ABE6531577Aaf2611CF66fa01094e8F1") as string
).toLowerCase() as Address;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC not set");
const RPCS = (process.env.RT_RPC_URLS ?? "https://sepolia.base.org")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DB_URL =
  process.env.RT_DB_URL ?? "postgres://rezontree:rezontree@localhost:5432/rezontree";

// Default lookback: ~30 days of Base Sepolia blocks (2s block time).
// Override with --from <block>.
const DEFAULT_LOOKBACK_BLOCKS = 1_300_000n;
// Public RPCs cap log range; 9_500 keeps us under most providers' 10k limit.
const CHUNK = 9_500n;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const ROLES = [
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

interface Wallet {
  idx: number;
  role: string;
  address: Address;
}

interface Transfer {
  block: bigint;
  txHash: Hex;
  logIndex: number;
  from: Address;
  to: Address;
  value: bigint;
}

interface ClassifiedTx extends Transfer {
  walletIdx: number; // which of our wallets is the counterparty subject
  direction: "in" | "out";
  counterparty: "forge" | "wallet" | "external";
  counterpartyIdx?: number; // sibling wallet idx, when counterparty=wallet
  dbLabel?: string; // sponsor/commit/vote/claim/refund/refund-projection
  dbQid?: string;
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: fallback(
    RPCS.map((url) => http(url, { batch: { batchSize: 200, wait: 16 } })),
  ),
});

function deriveWallets(): Wallet[] {
  return ROLES.map((role, idx) => {
    const a = mnemonicToAccount(MNEMONIC!, { addressIndex: idx });
    return { idx, role, address: a.address.toLowerCase() as Address };
  });
}

function pad32(addr: Address): Hex {
  return ("0x" + "0".repeat(24) + addr.slice(2).toLowerCase()) as Hex;
}

async function fetchTransfersForRange(
  fromTopics: Hex[],
  toTopics: Hex[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Transfer[]> {
  // Two queries per chunk: matching `from` OR matching `to`.
  // viem accepts arrays of indexed-arg values; we use raw topics for control.
  const tFromAny: any = [
    TRANSFER_EVENT, // signature topic[0]
  ];
  const queries: Promise<Transfer[]>[] = [];

  // We can't pass two different multi-topic filters in one getLogs call
  // (they're AND'd within a position). So we issue two queries.
  for (const variant of ["from", "to"] as const) {
    const args =
      variant === "from"
        ? { from: fromTopics.map((t) => ("0x" + t.slice(26)) as Address) }
        : { to: toTopics.map((t) => ("0x" + t.slice(26)) as Address) };
    queries.push(
      client
        .getLogs({
          address: USDC,
          event: TRANSFER_EVENT,
          args: args as any,
          fromBlock,
          toBlock,
        })
        .then((logs) =>
          logs.map((l) => ({
            block: l.blockNumber!,
            txHash: l.transactionHash!,
            logIndex: l.logIndex!,
            from: (l.args.from as Address).toLowerCase() as Address,
            to: (l.args.to as Address).toLowerCase() as Address,
            value: l.args.value as bigint,
          })),
        ),
    );
  }

  const [a, b] = await Promise.all(queries);
  // Dedupe by (txHash, logIndex)
  const seen = new Set<string>();
  const out: Transfer[] = [];
  for (const t of [...a, ...b]) {
    const k = `${t.txHash}:${t.logIndex}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

async function fetchAllTransfers(
  wallets: Wallet[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Transfer[]> {
  const topics = wallets.map((w) => pad32(w.address));
  const all: Transfer[] = [];
  let cursor = fromBlock;
  let chunks = 0;
  const totalChunks = Number((toBlock - fromBlock) / CHUNK) + 1;
  while (cursor <= toBlock) {
    const end = cursor + CHUNK - 1n > toBlock ? toBlock : cursor + CHUNK - 1n;
    try {
      const transfers = await fetchTransfersForRange(topics, topics, cursor, end);
      all.push(...transfers);
    } catch (e: any) {
      console.error(
        `  chunk ${cursor}-${end} failed: ${e?.shortMessage ?? e?.message ?? e}`,
      );
    }
    chunks++;
    if (chunks % 10 === 0) {
      process.stderr.write(
        `\r  fetched ${chunks}/${totalChunks} chunks, ${all.length} transfers...`,
      );
    }
    cursor = end + 1n;
  }
  process.stderr.write("\n");
  return all;
}

async function enrichFromDb(): Promise<Map<string, { label: string; qid: string }>> {
  const pg = new PgClient({ connectionString: DB_URL });
  await pg.connect();
  const map = new Map<string, { label: string; qid: string }>();
  // Action type lives in each domain table (contributions/solutions/votes
  // /round_results). signed_intents.submission_tx_hash links them. One UNION
  // per action gives us the label without payload-shape guessing.
  const sql = `
    SELECT encode(si.submission_tx_hash, 'hex') AS tx, 'sponsor/cosponsor' AS label, encode(si.question_id, 'hex') AS qid
    FROM signed_intents si JOIN contributions c ON c.intent_hash = si.intent_hash
    WHERE si.submission_tx_hash IS NOT NULL
    UNION ALL
    SELECT encode(si.submission_tx_hash, 'hex'), 'commit', encode(si.question_id, 'hex')
    FROM signed_intents si JOIN solutions s ON s.intent_hash = si.intent_hash
    WHERE si.submission_tx_hash IS NOT NULL
    UNION ALL
    SELECT encode(si.submission_tx_hash, 'hex'), 'vote', encode(si.question_id, 'hex')
    FROM signed_intents si JOIN votes v ON v.intent_hash = si.intent_hash
    WHERE si.submission_tx_hash IS NOT NULL
  `;
  try {
    const r = await pg.query(sql);
    for (const row of r.rows) {
      map.set(("0x" + row.tx).toLowerCase(), {
        label: row.label,
        qid: row.qid ? "0x" + row.qid : "",
      });
    }
  } catch (e: any) {
    console.error("  db enrichment failed:", e?.message ?? e);
  } finally {
    await pg.end();
  }
  return map;
}

function classify(
  transfers: Transfer[],
  wallets: Wallet[],
  dbMap: Map<string, { label: string; qid: string }>,
): ClassifiedTx[] {
  const byAddr = new Map<Address, number>();
  wallets.forEach((w) => byAddr.set(w.address, w.idx));

  const out: ClassifiedTx[] = [];
  for (const t of transfers) {
    const fromIdx = byAddr.get(t.from);
    const toIdx = byAddr.get(t.to);
    const counterpartyOf = (addr: Address): ClassifiedTx["counterparty"] => {
      if (addr === FORGE) return "forge";
      if (byAddr.has(addr)) return "wallet";
      return "external";
    };
    // A transfer can touch zero, one, or two of our wallets.
    if (fromIdx !== undefined) {
      const cp = counterpartyOf(t.to);
      const enrich = dbMap.get(t.txHash.toLowerCase());
      out.push({
        ...t,
        walletIdx: fromIdx,
        direction: "out",
        counterparty: cp,
        counterpartyIdx: toIdx,
        dbLabel: cp === "forge" ? enrich?.label : undefined,
        dbQid: cp === "forge" ? enrich?.qid : undefined,
      });
    }
    if (toIdx !== undefined) {
      const cp = counterpartyOf(t.from);
      const enrich = dbMap.get(t.txHash.toLowerCase());
      out.push({
        ...t,
        walletIdx: toIdx,
        direction: "in",
        counterparty: cp,
        counterpartyIdx: fromIdx,
        dbLabel: cp === "forge" ? enrich?.label : undefined,
        dbQid: cp === "forge" ? enrich?.qid : undefined,
      });
    }
  }
  return out;
}

function fmt(v: bigint) {
  return formatUnits(v, 6);
}

function summarize(rows: ClassifiedTx[], wallets: Wallet[]) {
  const perWallet = wallets.map((w) => ({
    ...w,
    inFromExternal: 0n,
    inFromForge: 0n,
    inFromWallet: 0n,
    outToExternal: 0n,
    outToForge: 0n,
    outToWallet: 0n,
    txCount: 0,
  }));
  for (const r of rows) {
    const w = perWallet[r.walletIdx];
    w.txCount++;
    if (r.direction === "in") {
      if (r.counterparty === "forge") w.inFromForge += r.value;
      else if (r.counterparty === "wallet") w.inFromWallet += r.value;
      else w.inFromExternal += r.value;
    } else {
      if (r.counterparty === "forge") w.outToForge += r.value;
      else if (r.counterparty === "wallet") w.outToWallet += r.value;
      else w.outToExternal += r.value;
    }
  }
  return perWallet;
}

async function main() {
  const args = process.argv.slice(2);
  const csv = args.includes("--csv");
  const fromArg = args.indexOf("--from");
  const wallets = deriveWallets();
  console.error(`derived ${wallets.length} wallets from RT_AGENT_MNEMONIC`);

  const tip = await client.getBlockNumber();
  const fromBlock =
    fromArg >= 0
      ? BigInt(args[fromArg + 1])
      : tip > DEFAULT_LOOKBACK_BLOCKS
        ? tip - DEFAULT_LOOKBACK_BLOCKS
        : 0n;
  console.error(`scanning USDC transfers ${fromBlock} → ${tip} (${tip - fromBlock} blocks)`);
  console.error(`USDC: ${USDC}`);
  console.error(`Forge: ${FORGE}`);

  const transfers = await fetchAllTransfers(wallets, fromBlock, tip);
  console.error(`total transfers touching our wallets: ${transfers.length}`);

  const txHashes = [...new Set(transfers.map((t) => t.txHash))];
  const dbMap = await enrichFromDb();
  const enriched = txHashes.filter((h) => dbMap.has(h.toLowerCase())).length;
  console.error(`DB-enriched ${enriched}/${txHashes.length} txs (rest predate DB reset or weren't Forge-touching)`);

  const classified = classify(transfers, wallets, dbMap);
  // Sort by block ascending
  classified.sort((a, b) => Number(a.block - b.block) || a.logIndex - b.logIndex);

  if (csv) {
    console.log("block,tx,wallet_idx,wallet_role,direction,counterparty,counterparty_idx,counterparty_addr,value_usdc,db_label,db_qid");
    for (const r of classified) {
      const w = wallets[r.walletIdx];
      const cpAddr = r.direction === "in" ? r.from : r.to;
      console.log(
        [
          r.block,
          r.txHash,
          r.walletIdx,
          w.role,
          r.direction,
          r.counterparty,
          r.counterpartyIdx ?? "",
          cpAddr,
          fmt(r.value),
          r.dbLabel ?? "",
          r.dbQid ?? "",
        ].join(","),
      );
    }
    return;
  }

  // Per-wallet ledger
  const summary = summarize(classified, wallets);
  console.log("");
  console.log("Per-wallet ledger (USDC):");
  console.log(
    "idx  role             txs   in:ext     in:forge   in:sib    out:ext    out:forge  out:sib    net      ",
  );
  console.log(
    "---  ---------------  ----  ---------  ---------  --------  ---------  ---------  --------  ---------",
  );
  let grand = {
    inExt: 0n,
    inForge: 0n,
    inSib: 0n,
    outExt: 0n,
    outForge: 0n,
    outSib: 0n,
  };
  for (const w of summary) {
    const net =
      w.inFromExternal +
      w.inFromForge +
      w.inFromWallet -
      w.outToExternal -
      w.outToForge -
      w.outToWallet;
    grand.inExt += w.inFromExternal;
    grand.inForge += w.inFromForge;
    grand.inSib += w.inFromWallet;
    grand.outExt += w.outToExternal;
    grand.outForge += w.outToForge;
    grand.outSib += w.outToWallet;
    console.log(
      `${String(w.idx).padStart(3)}  ${w.role.padEnd(15)}  ${String(w.txCount).padStart(4)}  ` +
        `${fmt(w.inFromExternal).padStart(9)}  ${fmt(w.inFromForge).padStart(9)}  ` +
        `${fmt(w.inFromWallet).padStart(8)}  ${fmt(w.outToExternal).padStart(9)}  ` +
        `${fmt(w.outToForge).padStart(9)}  ${fmt(w.outToWallet).padStart(8)}  ` +
        `${fmt(net).padStart(9)}`,
    );
  }
  console.log("---  ---------------  ----  ---------  ---------  --------  ---------  ---------  --------  ---------");
  const grandNet =
    grand.inExt + grand.inForge + grand.inSib - grand.outExt - grand.outForge - grand.outSib;
  console.log(
    `     TOTALS                  ${"".padStart(4)}  ${fmt(grand.inExt).padStart(9)}  ${fmt(grand.inForge).padStart(9)}  ` +
      `${fmt(grand.inSib).padStart(8)}  ${fmt(grand.outExt).padStart(9)}  ${fmt(grand.outForge).padStart(9)}  ` +
      `${fmt(grand.outSib).padStart(8)}  ${fmt(grandNet).padStart(9)}`,
  );

  // Current Forge USDC balance (still-locked from our fleet + others)
  const forgeBal = (await client.readContract({
    address: USDC,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "o", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [FORGE],
  })) as bigint;

  // Reconciliation
  console.log("");
  console.log("Reconciliation:");
  console.log(`  External inflow (faucet/funder):       ${fmt(grand.inExt).padStart(10)} USDC  ← original funding`);
  console.log(`  External outflow (sent elsewhere):     ${fmt(grand.outExt).padStart(10)} USDC  ← funds left the agent fleet`);
  console.log(`  Forge stake out (locked in escrow):    ${fmt(grand.outForge).padStart(10)} USDC  ← sponsor/commit/vote stakes`);
  console.log(`  Forge return (refund/payout/claim):    ${fmt(grand.inForge).padStart(10)} USDC  ← refunds + claims paid out`);
  console.log(`  Net protocol cost-so-far:              ${fmt(grand.outForge - grand.inForge).padStart(10)} USDC  ← still locked + slashed + fee'd`);
  console.log(`  Inter-wallet (rebalance):              ${fmt(grand.outSib).padStart(10)} out / ${fmt(grand.inSib)} in  (should match)`);
  console.log(`  Net wallet balance change vs external: ${fmt(grand.inExt - grand.outExt - (grand.outForge - grand.inForge)).padStart(10)} USDC`);
  console.log(`  Forge contract current USDC balance:   ${fmt(forgeBal).padStart(10)} USDC  (incl. funds from other operators if shared chain)`);

  // Top external-outflow destinations
  const extOut = new Map<Address, bigint>();
  for (const r of classified) {
    if (r.direction === "out" && r.counterparty === "external") {
      extOut.set(r.to, (extOut.get(r.to) ?? 0n) + r.value);
    }
  }
  if (extOut.size > 0) {
    console.log("");
    console.log("Top 10 external-outflow destinations (USDC left the fleet):");
    const sorted = [...extOut.entries()].sort((a, b) => Number(b[1] - a[1])).slice(0, 10);
    for (const [addr, v] of sorted) {
      console.log(`  ${addr}  ${fmt(v).padStart(10)} USDC`);
    }
  }

  // Top external-inflow sources
  const extIn = new Map<Address, bigint>();
  for (const r of classified) {
    if (r.direction === "in" && r.counterparty === "external") {
      extIn.set(r.from, (extIn.get(r.from) ?? 0n) + r.value);
    }
  }
  if (extIn.size > 0) {
    console.log("");
    console.log("Top 10 external-inflow sources (where original funds came from):");
    const sorted = [...extIn.entries()].sort((a, b) => Number(b[1] - a[1])).slice(0, 10);
    for (const [addr, v] of sorted) {
      console.log(`  ${addr}  ${fmt(v).padStart(10)} USDC`);
    }
  }

  // Action-type breakdown
  console.log("");
  console.log("Forge-touching transfers by DB label:");
  const byLabel = new Map<string, { count: number; out: bigint; in: bigint }>();
  for (const r of classified) {
    if (r.counterparty !== "forge") continue;
    const key = r.dbLabel ?? "(predates DB reset / no signed_intent)";
    const cur = byLabel.get(key) ?? { count: 0, out: 0n, in: 0n };
    cur.count++;
    if (r.direction === "out") cur.out += r.value;
    else cur.in += r.value;
    byLabel.set(key, cur);
  }
  for (const [label, v] of [...byLabel.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${label.padEnd(48)}  ${String(v.count).padStart(4)}x   out=${fmt(v.out).padStart(9)}  in=${fmt(v.in).padStart(9)}`);
  }

  // DB reset boundary check
  if (dbMap.size < txHashes.length) {
    console.log("");
    console.log(`Note: ${txHashes.length - dbMap.size} chain txs have no matching signed_intent row.`);
    console.log("      Most are pre-DB-reset (2026-05-06) or non-protocol transfers (faucet/rebalance/external).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
