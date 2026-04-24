// accounting/balances.ts — fund-conservation audit.
//
// Every protocol action moves USDC between known actors: agent
// wallets and the Router contract. Total USDC across all actors is
// invariant over any action (gas is paid in ETH, not USDC).
//
// Snapshots capture balances and per-qid Router state; verifyDelta
// compares two snapshots against an ExpectedDelta and reports any
// drift as an accounting bug.

import type { Address, Hex, PublicClient } from "viem";
import { erc20Abi } from "viem";

/** One USDC balance snapshot for a named actor. */
export interface ActorBalance {
  name: string;
  address: Address;
  usdc: bigint;
}

/** Full balance snapshot across the system. */
export interface BalanceSnapshot {
  takenAtMs: number;
  wallets: ActorBalance[];
  router: {
    address: Address;
    totalUsdc: bigint;
    /** Per-qid pool amounts (known qids only — we track them as
     *  agents create them). Sum ≤ totalUsdc; residual = totalUsdc
     *  − sum(pools) − sum(bonds). */
    pools: Record<Hex, bigint>;
    /** Known solution-bond amounts keyed by intent_hash. */
    solutionBonds: Record<Hex, bigint>;
    /** Known vote-bond amounts keyed by intent_hash. */
    voteBonds: Record<Hex, bigint>;
  };
  /** Sum across wallets + router. Invariant over any action. */
  totalUsdc: bigint;
}

/** Inputs to take a snapshot. */
export interface SnapshotInput {
  publicClient: PublicClient;
  usdc: Address;
  router: Address;
  wallets: { name: string; address: Address }[];
  /** Known qids to query pool amounts for. */
  qids: Hex[];
  /** Known intent hashes to query bonds for. */
  solutionIntentHashes: Hex[];
  voteIntentHashes: Hex[];
}

const routerReadAbi = [
  {
    type: "function",
    name: "questions",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "tokenAddr", type: "address" },
      { name: "solutionCount", type: "uint32" },
      { name: "poolAmount", type: "uint256" },
      { name: "fundingDeadline", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "solutionBond",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "voteBond",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function snapshot(input: SnapshotInput): Promise<BalanceSnapshot> {
  const walletBalances = await Promise.all(
    input.wallets.map(async (w): Promise<ActorBalance> => ({
      name: w.name,
      address: w.address,
      usdc: (await input.publicClient.readContract({
        address: input.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [w.address],
      })) as bigint,
    })),
  );

  const routerTotal = (await input.publicClient.readContract({
    address: input.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [input.router],
  })) as bigint;

  const pools: Record<Hex, bigint> = {};
  for (const qid of input.qids) {
    const q = (await input.publicClient.readContract({
      address: input.router,
      abi: routerReadAbi,
      functionName: "questions",
      args: [qid],
    })) as [number, Address, number, bigint, bigint];
    pools[qid] = q[3];
  }

  const solutionBonds: Record<Hex, bigint> = {};
  for (const h of input.solutionIntentHashes) {
    solutionBonds[h] = (await input.publicClient.readContract({
      address: input.router,
      abi: routerReadAbi,
      functionName: "solutionBond",
      args: [h],
    })) as bigint;
  }

  const voteBonds: Record<Hex, bigint> = {};
  for (const h of input.voteIntentHashes) {
    voteBonds[h] = (await input.publicClient.readContract({
      address: input.router,
      abi: routerReadAbi,
      functionName: "voteBond",
      args: [h],
    })) as bigint;
  }

  const totalUsdc =
    walletBalances.reduce((acc, w) => acc + w.usdc, 0n) + routerTotal;

  return {
    takenAtMs: Date.now(),
    wallets: walletBalances,
    router: {
      address: input.router,
      totalUsdc: routerTotal,
      pools,
      solutionBonds,
      voteBonds,
    },
    totalUsdc,
  };
}

// ─── Expected-delta spec ───────────────────────────────────────

export type ActionName =
  | "fund"
  | "commit"
  | "vote"
  | "settle" // no USDC movement
  | "claim"
  | "claim_solution_bond"
  | "claim_vote_bond"
  | "sweep_residuals";

/** Per-action expected delta. Positive = inflow, negative = outflow.
 *  Units: USDC wei (6dp). Unspecified wallets default to 0 delta. */
export interface ExpectedDelta {
  action: ActionName;
  byAddress: Partial<Record<Address, bigint>>;
  routerTotal: bigint;
  qid?: Hex;
  poolDelta?: bigint;
  intentHash?: Hex;
  solutionBondDelta?: bigint;
  voteBondDelta?: bigint;
  /** Overall chain total should be unchanged (no USDC leaves). */
  chainTotal: bigint; // always 0n
}

/** Compare two snapshots and a declared expected delta. */
export function verifyDelta(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  expected: ExpectedDelta,
): {
  ok: boolean;
  mismatches: string[];
  actualByAddress: Record<Address, bigint>;
  actualRouterTotal: bigint;
  actualChainTotal: bigint;
} {
  const mismatches: string[] = [];

  // Per-wallet actual delta.
  const actualByAddress: Record<Address, bigint> = {};
  for (const w of after.wallets) {
    const b = before.wallets.find((x) => x.address === w.address);
    if (!b) continue;
    actualByAddress[w.address] = w.usdc - b.usdc;
  }
  for (const addr of Object.keys(expected.byAddress) as Address[]) {
    const exp = expected.byAddress[addr] ?? 0n;
    const act = actualByAddress[addr] ?? 0n;
    if (exp !== act) {
      mismatches.push(
        `wallet ${addr}: expected ${exp}, actual ${act} (diff ${act - exp})`,
      );
    }
  }

  // Wallets NOT in expected should have delta 0.
  for (const [addr, act] of Object.entries(actualByAddress)) {
    if (!(addr in expected.byAddress) && act !== 0n) {
      mismatches.push(
        `wallet ${addr}: expected 0 (not in spec), actual ${act}`,
      );
    }
  }

  // Router total.
  const actualRouterTotal = after.router.totalUsdc - before.router.totalUsdc;
  if (actualRouterTotal !== expected.routerTotal) {
    mismatches.push(
      `router total: expected ${expected.routerTotal}, actual ${actualRouterTotal}`,
    );
  }

  // Pool delta for specific qid.
  if (expected.qid !== undefined) {
    const poolBefore = before.router.pools[expected.qid] ?? 0n;
    const poolAfter = after.router.pools[expected.qid] ?? 0n;
    const actualPool = poolAfter - poolBefore;
    const expectedPool = expected.poolDelta ?? 0n;
    if (actualPool !== expectedPool) {
      mismatches.push(
        `pool[${expected.qid}]: expected ${expectedPool}, actual ${actualPool}`,
      );
    }
  }

  // Bond deltas.
  if (expected.intentHash !== undefined) {
    if (expected.solutionBondDelta !== undefined) {
      const b = before.router.solutionBonds[expected.intentHash] ?? 0n;
      const a = after.router.solutionBonds[expected.intentHash] ?? 0n;
      const actual = a - b;
      if (actual !== expected.solutionBondDelta) {
        mismatches.push(
          `solutionBond[${expected.intentHash}]: expected ${expected.solutionBondDelta}, actual ${actual}`,
        );
      }
    }
    if (expected.voteBondDelta !== undefined) {
      const b = before.router.voteBonds[expected.intentHash] ?? 0n;
      const a = after.router.voteBonds[expected.intentHash] ?? 0n;
      const actual = a - b;
      if (actual !== expected.voteBondDelta) {
        mismatches.push(
          `voteBond[${expected.intentHash}]: expected ${expected.voteBondDelta}, actual ${actual}`,
        );
      }
    }
  }

  // Chain total must be conserved (no USDC leaves).
  const actualChainTotal = after.totalUsdc - before.totalUsdc;
  if (actualChainTotal !== expected.chainTotal) {
    mismatches.push(
      `CHAIN TOTAL DRIFTED: expected ${expected.chainTotal}, actual ${actualChainTotal} — USDC leaked out of or into the system`,
    );
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    actualByAddress,
    actualRouterTotal,
    actualChainTotal,
  };
}

// ─── Pretty printing ───────────────────────────────────────────

/** Format USDC wei as a human "1.23 USDC" string (6dp). */
export function fmtUsdc(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  const s = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return (neg ? "-" : "") + s + " USDC";
}

export function printSnapshot(snap: BalanceSnapshot, title = "Balance sheet"): void {
  console.log("");
  console.log(`── ${title} @ ${new Date(snap.takenAtMs).toISOString()} ──`);
  for (const w of snap.wallets) {
    console.log(`  ${w.name.padEnd(14)} ${w.address}  ${fmtUsdc(w.usdc).padStart(14)}`);
  }
  console.log(`  ${"router".padEnd(14)} ${snap.router.address}  ${fmtUsdc(snap.router.totalUsdc).padStart(14)}`);
  const poolsSum = Object.values(snap.router.pools).reduce((a, b) => a + b, 0n);
  const solBondsSum = Object.values(snap.router.solutionBonds).reduce(
    (a, b) => a + b,
    0n,
  );
  const voteBondsSum = Object.values(snap.router.voteBonds).reduce(
    (a, b) => a + b,
    0n,
  );
  const residuals = snap.router.totalUsdc - poolsSum - solBondsSum - voteBondsSum;
  console.log(
    `    ├─ pools       ${fmtUsdc(poolsSum).padStart(14)}  (${Object.keys(snap.router.pools).length} qid${Object.keys(snap.router.pools).length === 1 ? "" : "s"})`,
  );
  console.log(
    `    ├─ sol bonds   ${fmtUsdc(solBondsSum).padStart(14)}  (${Object.keys(snap.router.solutionBonds).length} intent${Object.keys(snap.router.solutionBonds).length === 1 ? "" : "s"})`,
  );
  console.log(
    `    ├─ vote bonds  ${fmtUsdc(voteBondsSum).padStart(14)}  (${Object.keys(snap.router.voteBonds).length} intent${Object.keys(snap.router.voteBonds).length === 1 ? "" : "s"})`,
  );
  console.log(`    └─ residuals   ${fmtUsdc(residuals).padStart(14)}`);
  console.log(`  ${"─".repeat(58)}`);
  console.log(`  ${"chain total".padEnd(14)} ${" ".repeat(42)} ${fmtUsdc(snap.totalUsdc).padStart(14)}`);
}

export function printDelta(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  label: string,
): void {
  console.log("");
  console.log(`── Δ ${label} ──`);
  for (const w of after.wallets) {
    const b = before.wallets.find((x) => x.address === w.address);
    if (!b) continue;
    const d = w.usdc - b.usdc;
    if (d !== 0n) {
      const sign = d > 0n ? "+" : "";
      console.log(`  ${w.name.padEnd(14)} ${sign}${fmtUsdc(d)}`);
    }
  }
  const routerDelta = after.router.totalUsdc - before.router.totalUsdc;
  if (routerDelta !== 0n) {
    const sign = routerDelta > 0n ? "+" : "";
    console.log(`  ${"router".padEnd(14)} ${sign}${fmtUsdc(routerDelta)}`);
  }
  const chainDelta = after.totalUsdc - before.totalUsdc;
  console.log(`  ${"chain total".padEnd(14)} ${chainDelta === 0n ? "≡ (conserved)" : `DRIFT ${fmtUsdc(chainDelta)}`}`);
}
