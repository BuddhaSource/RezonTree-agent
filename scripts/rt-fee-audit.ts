// rt-fee-audit.ts — full economic audit of the hosted run.
// Verifies the 10% fee was computed correctly on EVERY settled question
// (re-deriving the contract's own integer formula), confirms abandoned
// questions took no fee, and closes the system-wide conservation ledger.
import { createPublicClient, http, getAddress, formatUnits, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const API = (process.env.RT_BACKEND_URL ?? "https://rezontree.com").replace(/\/$/, "");
const FORGE = getAddress(process.env.RT_FORGE_ADDRESS as string);
const USDC = getAddress(process.env.RT_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const M = process.env.RT_AGENT_MNEMONIC as string;
const FEE_SINK = getAddress("0x83316aA3931D58058B5216233Ef122Cdd32Eed2F");
const FEE_BPS = 1000n; // 10% — frozen feeShareBps (confirmed via preflight)
const u = (b: bigint) => formatUnits(b, 6);

async function main() {
  const client = createPublicClient({ transport: http(RPC) });
  const balOf = (a: Address) => client.readContract({ address: USDC, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [a] }) as Promise<bigint>;

  // 1) enumerate every terminal question from the board
  const all: any[] = [];
  for (let off = 0; ; off += 100) {
    const j: any = await (await fetch(`${API}/v1/questions?limit=100&offset=${off}`)).json();
    const p: any[] = j.questions || j.data || [];
    all.push(...p);
    if (p.length < 100) break;
  }
  const settled = all.filter((q) => q.status === "settled");
  const abandoned = all.filter((q) => q.status === "abandoned");

  // 2) per-settled fee correctness: feeTotal == floor(pool * FEE_BPS / 10000), pool = fee + claimable
  let sumFee = 0n, sumClaim = 0n, sumPool = 0n, bad = 0, abFee = 0;
  console.log(`\n── PER-SETTLED FEE CHECK (${settled.length} questions) ──`);
  console.log(`  ${"question".padEnd(24)} ${"pool".padStart(10)} ${"fee".padStart(9)} ${"claimable".padStart(10)} ${"expFee".padStart(9)}  ok`);
  for (const q of settled) {
    const d: any = await (await fetch(`${API}/v1/questions/${q.id}`)).json();
    const det = d.question ?? d.data ?? d;
    const fee = BigInt(det.chainFeeTotal ?? "0");
    const claim = BigInt(det.chainTotalClaimable ?? "0");
    const pool = fee + claim;
    const expFee = (pool * FEE_BPS) / 10000n; // contract's integer formula (round down)
    const ok = fee === expFee;
    if (!ok) bad++;
    sumFee += fee; sumClaim += claim; sumPool += pool;
    if (!ok || settled.indexOf(q) < 5) // print first 5 + any mismatch
      console.log(`  ${q.id.padEnd(24)} ${u(pool).padStart(10)} ${u(fee).padStart(9)} ${u(claim).padStart(10)} ${u(expFee).padStart(9)}  ${ok ? "✓" : "✗ MISMATCH"}`);
  }
  // abandoned must carry zero fee (full refund)
  for (const q of abandoned) {
    const d: any = await (await fetch(`${API}/v1/questions/${q.id}`)).json();
    const det = d.question ?? d.data ?? d;
    if (BigInt(det.chainFeeTotal ?? "0") !== 0n) abFee++;
  }

  // 3) live on-chain fee state
  const accrued = await client.readContract({ address: FORGE, abi: [{ type: "function", name: "accruedFees", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "accruedFees", args: [FEE_SINK, USDC] }) as bigint;
  const sinkBal = await balOf(FEE_SINK);
  const forgeBal = await balOf(FORGE);

  // 4) wallet survey for conservation
  let wallets = 0n;
  for (let i = 0; i < 14; i++) wallets += await balOf(mnemonicToAccount(M, { addressIndex: i }).address as Address);

  console.log(`\n── FEE AGGREGATE ──`);
  console.log(`  settled with mismatched fee:     ${bad}  ${bad === 0 ? "✓ all correct" : "✗"}`);
  console.log(`  abandoned with non-zero fee:     ${abFee}  ${abFee === 0 ? "✓ all full-refund" : "✗"}`);
  console.log(`  Σ settle pool   = ${u(sumPool)} USDC`);
  console.log(`  Σ feeTotal      = ${u(sumFee)} USDC`);
  console.log(`  Σ totalClaimable= ${u(sumClaim)} USDC`);
  console.log(`  fee / pool      = ${(Number(sumFee) / Number(sumPool) * 100).toFixed(4)}%   (target 10.0000%)`);
  console.log(`  claimable/fee   = ${(Number(sumClaim) / Number(sumFee)).toFixed(4)}     (target 9.0000 — the 90/10 split)`);

  console.log(`\n── FEE → CHAIN RECONCILIATION ──`);
  console.log(`  Σ chainFeeTotal (settled Qs) = ${u(sumFee)}`);
  console.log(`  accruedFees(sink) now        = ${u(accrued)}  (0 = withdrawn)`);
  console.log(`  fee-sink USDC balance now    = ${u(sinkBal)}  (== Σ fee, received via withdrawFees)`);
  console.log(`  match: Σfee == sinkBalance?  ${sumFee === sinkBal ? "✓ EXACT" : `✗ Δ=${u(sumFee - sinkBal)}`}`);

  console.log(`\n── SYSTEM CONSERVATION ──`);
  const lhs = wallets + sinkBal + forgeBal;
  console.log(`  Σ 14 wallets    = ${u(wallets)}`);
  console.log(`  fee-sink        = ${u(sinkBal)}`);
  console.log(`  forge residual  = ${u(forgeBal)}  (target 0)`);
  console.log(`  TOTAL (LHS)     = ${u(lhs)} USDC`);
  console.log(`  baseline        = 375.140000 USDC`);
  console.log(`  Δ vs baseline   = ${u(lhs - 375140000n)} USDC`);
}
main().catch((e) => { console.error("AUDIT ERROR:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
