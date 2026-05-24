// finance-audit.ts — fund-conservation audit for the battle harness.
//
// Computes per-question and per-wallet USDC accounting from on-chain
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
//                          + stake_refunded
//                          - stake_slashed
//
//   per question; and across the whole battle:
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

// v2 read ABI. The v1 per-question `questions()` getter + the
// per-intent `solutionStake`/`voteStake` views were REMOVED in the
// unified-envelope contract (#595). v2 exposes scalar question state via
// `getQuestionScalars(qid) → (token, status, poolAmount, feeShareSet)`.
//
// Per-intent on-chain stake views no longer exist: in the unified model,
// locked stakes are folded into the question pool and tracked off-chain
// by the indexer/reconciler. The conservation audit therefore reconciles
// on the question pool + wallet balances (the real on-chain invariant —
// Σwallets + ΣforgePools is conserved across a lifecycle) and treats
// per-intent stake held as a derived quantity (committed − refunded −
// slashed), not a chain read.
export const FORGE_READ_ABI = [
  {
    type: "function",
    name: "getQuestionScalars",
    stateMutability: "view",
    inputs: [{ name: "qid", type: "bytes32" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "status", type: "uint8" },
      { name: "poolAmount", type: "uint256" },
      { name: "feeShareSet", type: "bool" },
    ],
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

export interface QuestionRecord {
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
  forgeTotalUsdc: bigint;
  pools: Record<Hex, bigint>;
  totalUsdc: bigint;
}

export interface PerQuestionAudit {
  scenarioId: string;
  qid: Hex;
  poolFundedTotal: bigint;
  poolDistributed: bigint;
  poolResidual: bigint;
  stakesCommittedTotal: bigint;
  stakesRefundedTotal: bigint;
  stakesSlashedTotal: bigint;
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
  perQuestion: PerQuestionAudit[];
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
  forge: Address;
  wallets: Address[];
  qids: Hex[];
}): Promise<FinanceSnapshot> {
  const balanceCalls = params.wallets.map((addr) =>
    params.publicClient.readContract({
      address: params.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr],
    }) as Promise<bigint>,
  );
  const forgeTotalP = params.publicClient.readContract({
    address: params.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [params.forge],
  }) as Promise<bigint>;

  const poolCalls = params.qids.map((qid) =>
    params.publicClient.readContract({
      address: params.forge,
      abi: FORGE_READ_ABI,
      functionName: "getQuestionScalars",
      args: [qid],
    }) as Promise<readonly [Address, number, bigint, boolean]>,
  );

  const [balances, forgeTotal, poolStates] = await Promise.all([
    Promise.all(balanceCalls),
    forgeTotalP,
    Promise.all(poolCalls),
  ]);

  const walletBalances: Record<Address, bigint> = {};
  let totalWallets = 0n;
  for (let i = 0; i < params.wallets.length; i++) {
    walletBalances[params.wallets[i]] = balances[i];
    totalWallets += balances[i];
  }
  const pools: Record<Hex, bigint> = {};
  for (let i = 0; i < params.qids.length; i++) {
    // getQuestionScalars → (token, status, poolAmount, feeShareSet);
    // poolAmount is index 2.
    pools[params.qids[i]] = poolStates[i][2];
  }

  return {
    takenAtMs: Date.now(),
    walletBalances,
    forgeTotalUsdc: forgeTotal,
    pools,
    totalUsdc: totalWallets + forgeTotal,
  };
}

// ── Per-question reconciliation ──────────────────────────────────

export interface QuestionTrace {
  scenarioId: string;
  qid: Hex;
  poolInflowsWei: bigint;          // sum of sponsor + cosponsor amounts
  stakesCommittedWei: bigint;       // sum of every commit/vote stake locked
  stakesRefundedWei: bigint;        // sum of every claimed stake
  stakesSlashedWei: bigint;         // sum of slashed stakes (added to pool)
  poolDistributedWei: bigint;      // sum of claim() amounts that came out of pool
  feeShareDistributedWei: bigint;  // routed to feeShares recipients
  protocolFeeWei: bigint;          // routed to fee_wallet
}

// v2 reconciliation. In the unified-envelope model the question's
// on-chain `poolAmount` (read via getQuestionScalars) holds BOTH the
// bounty inflows AND every locked commit/vote stake until settlement /
// refund moves them out. There are no separate per-intent stake views to
// read, so the chain-readable invariant collapses to a single quantity:
//
//   finalPool == poolInflows + stakesCommitted + stakesSlashed
//                - poolDistributed - feeShareDistributed - protocolFee
//                - stakesRefunded
//
// i.e. everything that flowed in (bounty + stakes + slashes) minus
// everything pulled out (payouts + fees + refunded stakes) must equal
// what the chain still holds in the pool. Drift ≠ 0 is a conservation
// violation.
export function reconcileQuestion(t: QuestionTrace, finalPool: bigint): PerQuestionAudit {
  const distributed =
    t.poolDistributedWei +
    t.feeShareDistributedWei +
    t.protocolFeeWei;

  const expectedPool =
    t.poolInflowsWei +
    t.stakesCommittedWei +
    t.stakesSlashedWei -
    distributed -
    t.stakesRefundedWei;
  const drift = finalPool - expectedPool;

  const notes: string[] = [];
  if (drift !== 0n) notes.push(`pool drift ${drift.toString()} wei`);
  if (notes.length === 0) notes.push("conserves");

  return {
    scenarioId: t.scenarioId,
    qid: t.qid,
    poolFundedTotal: t.poolInflowsWei,
    poolDistributed: distributed,
    poolResidual: finalPool,
    stakesCommittedTotal: t.stakesCommittedWei,
    stakesRefundedTotal: t.stakesRefundedWei,
    stakesSlashedTotal: t.stakesSlashedWei,
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
