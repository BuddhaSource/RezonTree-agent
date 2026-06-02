// rt-reconcile.ts — 4-layer reconciliation + economic tally for the swarm run.
// For every question on the board (L4 API): cross-check status + pool against
// the chain (L1 getQuestionScalars), tally pools, and compare Σ pools to the
// forge's actual USDC balance (conservation).
import { createPublicClient, http, fallback, formatUnits, keccak256, toBytes, parseAbiItem, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

const API = "https://rezontree.com";
const FORGE = "0x3664519d222Aa39e0953A59d1A0CE3e7DEF2e170" as Address;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const CHAIN = 84532;
const pub = createPublicClient({ chain: baseSepolia, transport: fallback(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"].map((u) => http(u))) });
const SCALARS = parseAbiItem("function getQuestionScalars(bytes32) view returns (address token, uint8 status, uint256 poolAmount, bool feeShareSet)");
const BAL = parseAbiItem("function balanceOf(address) view returns (uint256)");
const STATUS = ["None", "Open", "?2", "Settled", "Abandoned", "Recovered"];
const qid = (id: string): Hex => keccak256(toBytes(`${id.toLowerCase()}|${CHAIN}`));
const j = async (p: string) => (await fetch(`${API}${p}`)).json();

async function main() {
  const board = await j(`/v1/questions?prefer=minimal`);
  const list: any[] = board.questions || board.data || board || [];
  console.log(`L4 board: ${list.length} questions\n`);
  let l4Pool = 0n, l1Pool = 0n, sols = 0, votes = 0, mism = 0, open = 0;
  const byStatus: Record<string, number> = {};
  console.log("qst_id".padEnd(26), "L4status".padEnd(9), "L1status".padEnd(9), "L4pool".padStart(8), "L1pool".padStart(8), "sols", "votes", "match");
  for (const q of list) {
    const id = q.id || q.questionId;
    const det = await j(`/v1/questions/${id}?include=solutions,votes`);
    const l4status = det.status || "?";
    const l4pool = BigInt(det.chain_pool_amount ?? det.chainPoolAmount ?? 0);
    const ns = (det.solutions || det.solution_count || []).length ?? det.solution_count ?? 0;
    const nv = (det.votes || det.vote_count || []).length ?? det.vote_count ?? 0;
    let l1status = "?", l1pool = 0n;
    try {
      const sc = (await pub.readContract({ address: FORGE, abi: [SCALARS], functionName: "getQuestionScalars", args: [qid(id)] })) as readonly [Address, number, bigint, boolean];
      l1status = STATUS[sc[1]] ?? `s${sc[1]}`; l1pool = sc[2];
    } catch { l1status = "RPC_ERR"; }
    byStatus[l4status] = (byStatus[l4status] ?? 0) + 1;
    l4Pool += l4pool; l1Pool += l1pool; sols += Number(ns) || 0; votes += Number(nv) || 0;
    if (l4status === "open") open++;
    const poolMatch = l4pool === l1pool;
    const statusMatch = (l4status === "open" && l1status === "Open") || l4status.toLowerCase() === l1status.toLowerCase();
    if (!poolMatch || !statusMatch) mism++;
    console.log(String(id).padEnd(26), String(l4status).padEnd(9), l1status.padEnd(9), formatUnits(l4pool, 6).padStart(8), formatUnits(l1pool, 6).padStart(8), String(ns).padStart(4), String(nv).padStart(5), poolMatch && statusMatch ? "✓" : "✗ DRIFT");
  }
  const forgeBal = (await pub.readContract({ address: USDC, abi: [BAL], functionName: "balanceOf", args: [FORGE] })) as bigint;
  console.log(`\n── TALLY ──`);
  console.log(`status dist (L4): ${JSON.stringify(byStatus)}`);
  console.log(`Σ pool L4 (API): ${formatUnits(l4Pool, 6)} USDC | Σ pool L1 (chain): ${formatUnits(l1Pool, 6)} USDC | drift rows: ${mism}`);
  console.log(`solutions: ${sols} | votes: ${votes} | open: ${open}`);
  console.log(`forge USDC balance: ${formatUnits(forgeBal, 6)} USDC (escrowed across all questions incl. this forge's history)`);
  console.log(`Σ L1 pools vs forge balance: pools=${formatUnits(l1Pool, 6)} forge=${formatUnits(forgeBal, 6)} delta=${formatUnits(forgeBal - l1Pool, 6)} (delta = fees + stakes held beyond pools)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
