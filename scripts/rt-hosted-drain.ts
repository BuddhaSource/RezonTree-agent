// rt-hosted-drain.ts — DB-free fund recovery for the hosted swarm test.
//
// After the hosted keeper settles rounds, this drains every money-out door
// for the fleet: claim (winner payouts), refund (stake returns post-slash),
// and — via sweep-fees.ts run separately — withdrawFees (platform/referrer).
//
// Unlike sweep-recoverable.ts (which enumerates questions from the Postgres
// DB), this enumerates TERMINAL questions from the public API board, so it
// works against a hosted backend with no DB access. The per-(wallet,question)
// withdraw-door primitive (sweepWalletQuestion → POST .../intents/preflight
// {actionType:"withdraw"} → runClaimFlow / runRefundFlow) is reused verbatim
// from operator-recovery.ts.
//
// Usage:  tsx scripts/rt-hosted-drain.ts            # dry-run (default)
//         tsx scripts/rt-hosted-drain.ts --execute  # broadcast
import { formatUnits, type Address } from "viem";
import {
  buildWalletBank,
  loginWallet,
  sweepWalletQuestion,
  type DerivedWallet,
  type SweepOptions,
} from "./lib/operator-recovery.js";

const API = (process.env.RT_BACKEND_URL ?? "https://rezontree.com").replace(/\/$/, "");
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN = Number(process.env.RT_CHAIN_ID ?? "84532");
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const BANK = Number(process.env.RT_WALLET_BANK_SIZE ?? "14");
const EXECUTE = process.argv.includes("--execute");
const TERMINAL = new Set(["settled", "resolved", "abandoned", "recovered"]);

async function main() {
  if (!FORGE || !MNEMONIC) throw new Error("RT_FORGE_ADDRESS + RT_AGENT_MNEMONIC required (source the env)");
  console.log(`hosted-drain | api=${API} forge=${FORGE} chain=${CHAIN} | mode ${EXECUTE ? "EXECUTE" : "DRY-RUN"}`);

  // Enumerate TERMINAL questions from the board (paginated).
  const terminal: { id: string; status: string }[] = [];
  let offset = 0;
  for (;;) {
    const j: any = await (await fetch(`${API}/v1/questions?limit=100&offset=${offset}`)).json();
    const page: any[] = j.questions || j.data || (Array.isArray(j) ? j : []);
    for (const q of page) if (TERMINAL.has(q.status)) terminal.push({ id: q.id, status: q.status });
    if (page.length < 100 || !j.hasMore) break;
    offset += 100;
  }
  console.log(`terminal questions to sweep: ${terminal.length} (${JSON.stringify(terminal.reduce((a: any, q) => ((a[q.status] = (a[q.status] || 0) + 1), a), {}))})`);
  if (!terminal.length) { console.log("Nothing terminal yet — keeper hasn't settled. Re-run after settlement."); return; }

  const bank = buildWalletBank(MNEMONIC, BANK, CHAIN);
  // RT_DRAIN_ONLY_IDX scopes the drain to one wallet index — lets a workflow
  // fan out one drainer per wallet (each wallet has its own nonce space, so
  // concurrent per-wallet drains never collide). Unset = all wallets.
  const ONLY = process.env.RT_DRAIN_ONLY_IDX != null && process.env.RT_DRAIN_ONLY_IDX !== "" ? Number(process.env.RT_DRAIN_ONLY_IDX) : null;
  const opts: SweepOptions = { apiBase: API, forgeAddress: FORGE, rpcUrl: RPC, chainId: CHAIN, dryRun: !EXECUTE };
  const bearer = new Map<number, string>();

  let totalWei = 0n, items = 0, failures = 0;
  for (const q of terminal) {
    for (const w of bank.values()) {
      if (ONLY !== null && w.index !== ONLY) continue;
      if (!bearer.has(w.index)) {
        try { bearer.set(w.index, (await loginWallet(API, MNEMONIC, w.index)).bearer); }
        catch (e) { console.error(`  login idx=${w.index} failed: ${(e as Error).message}`); continue; }
      }
      const r = await sweepWalletQuestion(opts, w, bearer.get(w.index)!, q.id).catch((e: unknown) => {
        console.error(`  sweep idx=${w.index} q=${q.id} failed: ${(e as Error).message}`); return null;
      });
      if (!r || r.eligibleCount === 0) continue;
      totalWei += r.totalWithdrawnWei; failures += r.failures;
      for (const it of r.items) {
        if (it.status === "broadcast") { items++; console.log(`  ${EXECUTE ? "✓" : "DRY"} ${it.actionType.padEnd(6)} ${q.id} ${it.role.padEnd(14)} ${formatUnits(it.amountWei, 6).padStart(10)} USDC → idx=${w.index}${it.txHash ? ` tx=${it.txHash}` : ""}`); }
        else console.log(`  ✗ ${it.actionType} ${q.id} idx=${w.index}: ${it.error}`);
      }
    }
  }
  console.log(`\n── DRAIN ${EXECUTE ? "EXECUTED" : "DRY-RUN"} ──`);
  console.log(`claims+refunds: ${items} items, ${formatUnits(totalWei, 6)} USDC, ${failures} failures`);
  console.log(`Next: run sweep-fees.ts ${EXECUTE ? "--execute" : ""} for platform/referrer withdrawFees, then re-check forge balance.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
