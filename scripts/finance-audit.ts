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

// Local read ABI — REZON_FORGE_ABI in src/forge/abi.ts only declares
// the writable surface plus `questions` view; we add the stake view
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
      { name: "token", type: "address" },
      { name: "oracle", type: "address" },
      { name: "sponsor", type: "address" },
      { name: "stakeFloor", type: "uint256" },
      { name: "stakeBasisPoints", type: "uint256" },
      { name: "sponsorshipFloor", type: "uint256" },
      { name: "voteFee", type: "uint256" },
      { name: "abandonmentGracePeriod", type: "uint256" },
      { name: "solutionCount", type: "uint32" },
      { name: "totalSponsorship", type: "uint256" },
      { name: "poolAmount", type: "uint256" },
      { name: "fundingDeadline", type: "uint256" },
      { name: "totalClaimable", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "solutionStake",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "voteStake",
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
  solutionStakes: Record<Hex, bigint>;
  voteStakes: Record<Hex, bigint>;
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
  const forgeTotalP = params.publicClient.readContract({
    address: params.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [params.forge],
  }) as Promise<bigint>;

  const poolCalls = params.qids.map((qid) =>
    params.publicClient.readContract({
      address: params.forge,
      abi: ROUTER_READ_ABI,
      functionName: "questions",
      args: [qid],
    }) as Promise<readonly [number, Address, number, bigint, bigint]>,
  );
  const sStakeCalls = params.commitIntents.map((h) =>
    params.publicClient.readContract({
      address: params.forge,
      abi: ROUTER_READ_ABI,
      functionName: "solutionStake",
      args: [h],
    }) as Promise<bigint>,
  );
  const vStakeCalls = params.voteIntents.map((h) =>
    params.publicClient.readContract({
      address: params.forge,
      abi: ROUTER_READ_ABI,
      functionName: "voteStake",
      args: [h],
    }) as Promise<bigint>,
  );

  const [balances, forgeTotal, poolStates, sStakes, vStakes] = await Promise.all([
    Promise.all(balanceCalls),
    forgeTotalP,
    Promise.all(poolCalls),
    Promise.all(sStakeCalls),
    Promise.all(vStakeCalls),
  ]);

  const walletBalances: Record<Address, bigint> = {};
  let totalWallets = 0n;
  for (let i = 0; i < params.wallets.length; i++) {
    walletBalances[params.wallets[i]] = balances[i];
    totalWallets += balances[i];
  }
  const pools: Record<Hex, bigint> = {};
  for (let i = 0; i < params.qids.length; i++) {
    // poolAmount is the 12th field (0-indexed 11) of QuestionState —
    // see RezonForge.sol struct declaration. Index drift here was
    // the loop 0137 "uint256 in safe-int range" crash.
    pools[params.qids[i]] = poolStates[i][11];
  }
  const solutionStakes: Record<Hex, bigint> = {};
  for (let i = 0; i < params.commitIntents.length; i++) {
    solutionStakes[params.commitIntents[i]] = sStakes[i];
  }
  const voteStakes: Record<Hex, bigint> = {};
  for (let i = 0; i < params.voteIntents.length; i++) {
    voteStakes[params.voteIntents[i]] = vStakes[i];
  }

  return {
    takenAtMs: Date.now(),
    walletBalances,
    forgeTotalUsdc: forgeTotal,
    pools,
    solutionStakes,
    voteStakes,
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

export function reconcileQuestion(t: QuestionTrace, finalPool: bigint, finalSolStakes: bigint, finalVoteStakes: bigint): PerQuestionAudit {
  const distributed =
    t.poolDistributedWei +
    t.feeShareDistributedWei +
    t.protocolFeeWei;

  const expectedPoolResidual =
    t.poolInflowsWei + t.stakesSlashedWei - distributed;
  const poolResidual = finalPool;
  const poolDrift = poolResidual - expectedPoolResidual;

  const expectedStakesHeld =
    t.stakesCommittedWei - t.stakesRefundedWei - t.stakesSlashedWei;
  const observedStakesHeld = finalSolStakes + finalVoteStakes;
  const stakeDrift = observedStakesHeld - expectedStakesHeld;

  const drift = poolDrift + stakeDrift;
  const notes: string[] = [];
  if (poolDrift !== 0n) notes.push(`pool drift ${poolDrift.toString()} wei`);
  if (stakeDrift !== 0n) notes.push(`stake drift ${stakeDrift.toString()} wei`);
  if (notes.length === 0) notes.push("conserves");

  return {
    scenarioId: t.scenarioId,
    qid: t.qid,
    poolFundedTotal: t.poolInflowsWei,
    poolDistributed: distributed,
    poolResidual,
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
