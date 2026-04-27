// finance-audit.ts — fund-conservation audit for the battle harness.
//
// Computes per-problem and per-wallet USDC accounting from on-chain
// reads only (Router state + ERC-20 balances). The DB/indexer is
// a secondary source we cross-check against; chain is canonical.
//
// Conservation rule (R-CHAIN-VERIFIES-INTENT):
//   For one full lifecycle (sponsor → cosponsor* → commit* → vote*
//   → settle → claim*) we must have:
//
//      Σ inflow(actor)   ==  pool_distributed
//                          + fee_share_distributed
//                          + protocol_fee_distributed
//                          + bond_refunded
//                          - bond_slashed
//
//   per problem; and across the whole battle:
//
//      chain_total_USDC_before == chain_total_USDC_after
//
// The audit is deliberately read-only: it never broadcasts.

import {
  type Address,
  type Hex,
  type PublicClient,
  erc20Abi,
} from "viem";

// Local read ABI — REZON_FORGE_ABI in src/forge/abi.ts only declares
// the writable surface plus `questions` view; we add the bond view
// fns here without polluting that file. Mirrors src/accounting/
// balances.ts's local-abi pattern.
export const ROUTER_READ_ABI = [
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

// ── Types ────────────────────────────────────────────────────────

export interface NamedActor {
  name: string;
  address: Address;
  /** "sponsor" | "cosponsor" | "solver" | "voter" | "fee_wallet"
   *  | "operator" | "attacker". For sybil attribution the runner
   *  may also tag `operator_group_id` so the audit can roll up. */
  role: string;
  operator_group_id?: string;
}

export interface ProblemRecord {
  scenarioId: string;
  qid: Hex;
  intentHashes: {
    commits: Hex[];
    votes: Hex[];
  };
  actors: NamedActor[];
}

export interface FinanceSnapshot {
  takenAtMs: number;
  walletBalances: Record<Address, bigint>;
  routerTotalUsdc: bigint;
  pools: Record<Hex, bigint>;
  solutionBonds: Record<Hex, bigint>;
  voteBonds: Record<Hex, bigint>;
  totalUsdc: bigint;
}

export interface PerProblemAudit {
  scenarioId: string;
  qid: Hex;
  poolFundedTotal: bigint;
  poolDistributed: bigint;
  poolResidual: bigint;
  bondsCommittedTotal: bigint;
  bondsRefundedTotal: bigint;
  bondsSlashedTotal: bigint;
  conserves: boolean;
  drift: bigint;
  notes: string[];
}

export interface BattleAudit {
  startedAt: string;
  finishedAt: string;
  scenariosRun: number;
  conservedOverall: boolean;
  chainTotalDriftWei: bigint;
  perProblem: PerProblemAudit[];
  byActor: { address: Address; name: string; deltaWei: bigint }[];
  sybilFindings: string[];
  attackVectors: AttackResult[];
}

export interface AttackResult {
  scenarioId: string;
  attack: string;
  expectedDefenseLayer: string;
  defenseHeld: boolean;
  observed: string;
}

// ── Snapshot ─────────────────────────────────────────────────────

export async function snapshotFinance(params: {
  publicClient: PublicClient;
  usdc: Address;
  router: Address;
  wallets: Address[];
  qids: Hex[];
  commitIntents: Hex[];
  voteIntents: Hex[];
}): Promise<FinanceSnapshot> {
  const balanceCalls = params.wallets.map((addr) =>
    params.publicClient.readContract({
      address: params.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr],
    }) as Promise<bigint>,
  );
  const routerTotalP = params.publicClient.readContract({
    address: params.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [params.router],
  }) as Promise<bigint>;

  const poolCalls = params.qids.map((qid) =>
    params.publicClient.readContract({
      address: params.router,
      abi: ROUTER_READ_ABI,
      functionName: "questions",
      args: [qid],
    }) as Promise<readonly [number, Address, number, bigint, bigint]>,
  );
  const sBondCalls = params.commitIntents.map((h) =>
    params.publicClient.readContract({
      address: params.router,
      abi: ROUTER_READ_ABI,
      functionName: "solutionBond",
      args: [h],
    }) as Promise<bigint>,
  );
  const vBondCalls = params.voteIntents.map((h) =>
    params.publicClient.readContract({
      address: params.router,
      abi: ROUTER_READ_ABI,
      functionName: "voteBond",
      args: [h],
    }) as Promise<bigint>,
  );

  const [balances, routerTotal, poolStates, sBonds, vBonds] = await Promise.all([
    Promise.all(balanceCalls),
    routerTotalP,
    Promise.all(poolCalls),
    Promise.all(sBondCalls),
    Promise.all(vBondCalls),
  ]);

  const walletBalances: Record<Address, bigint> = {};
  let totalWallets = 0n;
  for (let i = 0; i < params.wallets.length; i++) {
    walletBalances[params.wallets[i]] = balances[i];
    totalWallets += balances[i];
  }
  const pools: Record<Hex, bigint> = {};
  for (let i = 0; i < params.qids.length; i++) {
    pools[params.qids[i]] = poolStates[i][3];
  }
  const solutionBonds: Record<Hex, bigint> = {};
  for (let i = 0; i < params.commitIntents.length; i++) {
    solutionBonds[params.commitIntents[i]] = sBonds[i];
  }
  const voteBonds: Record<Hex, bigint> = {};
  for (let i = 0; i < params.voteIntents.length; i++) {
    voteBonds[params.voteIntents[i]] = vBonds[i];
  }

  return {
    takenAtMs: Date.now(),
    walletBalances,
    routerTotalUsdc: routerTotal,
    pools,
    solutionBonds,
    voteBonds,
    totalUsdc: totalWallets + routerTotal,
  };
}

// ── Per-problem reconciliation ──────────────────────────────────

export interface ProblemTrace {
  scenarioId: string;
  qid: Hex;
  poolInflowsWei: bigint;          // sum of sponsor + cosponsor amounts
  bondsCommittedWei: bigint;       // sum of every commit/vote bond locked
  bondsRefundedWei: bigint;        // sum of every claimed bond
  bondsSlashedWei: bigint;         // sum of slashed bonds (added to pool)
  poolDistributedWei: bigint;      // sum of claim() amounts that came out of pool
  feeShareDistributedWei: bigint;  // routed to feeShares recipients
  protocolFeeWei: bigint;          // routed to fee_wallet
}

export function reconcileProblem(t: ProblemTrace, finalPool: bigint, finalSolBonds: bigint, finalVoteBonds: bigint): PerProblemAudit {
  const distributed =
    t.poolDistributedWei +
    t.feeShareDistributedWei +
    t.protocolFeeWei;

  const expectedPoolResidual =
    t.poolInflowsWei + t.bondsSlashedWei - distributed;
  const poolResidual = finalPool;
  const poolDrift = poolResidual - expectedPoolResidual;

  const expectedBondsHeld =
    t.bondsCommittedWei - t.bondsRefundedWei - t.bondsSlashedWei;
  const observedBondsHeld = finalSolBonds + finalVoteBonds;
  const bondDrift = observedBondsHeld - expectedBondsHeld;

  const drift = poolDrift + bondDrift;
  const notes: string[] = [];
  if (poolDrift !== 0n) notes.push(`pool drift ${poolDrift.toString()} wei`);
  if (bondDrift !== 0n) notes.push(`bond drift ${bondDrift.toString()} wei`);
  if (notes.length === 0) notes.push("conserves");

  return {
    scenarioId: t.scenarioId,
    qid: t.qid,
    poolFundedTotal: t.poolInflowsWei,
    poolDistributed: distributed,
    poolResidual,
    bondsCommittedTotal: t.bondsCommittedWei,
    bondsRefundedTotal: t.bondsRefundedWei,
    bondsSlashedTotal: t.bondsSlashedWei,
    conserves: drift === 0n,
    drift,
    notes,
  };
}

// ── CSV / JSON renderers ────────────────────────────────────────

export function renderActorDeltaCsv(
  before: FinanceSnapshot,
  after: FinanceSnapshot,
  actors: NamedActor[],
): string {
  const lines = [
    "name,address,role,operator_group,delta_wei",
  ];
  for (const a of actors) {
    const b = before.walletBalances[a.address] ?? 0n;
    const x = after.walletBalances[a.address] ?? 0n;
    lines.push(
      `${a.name},${a.address},${a.role},${a.operator_group_id ?? ""},${(x - b).toString()}`,
    );
  }
  return lines.join("\n");
}

export function fmtUsdc6(wei: bigint): string {
  // USDC has 6 decimals; print with sign for readability.
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}
