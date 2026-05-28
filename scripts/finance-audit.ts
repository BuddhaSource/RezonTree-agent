// finance-audit.ts — fund-conservation audit for the battle harness.
//
// Computes per-question and per-wallet USDC accounting from on-chain
// reads only (Router state + ERC-20 balances + accruedFees). The
// DB/indexer is a secondary source we cross-check against; chain is
// canonical.
//
// ── Conservation rule — realized-outcome fee model (docs/economics.md §0) ──
//
// The fee is NO LONGER taken at commit/vote action time. Commit and
// vote carry feeAmount=0 and a refundable stake only (§0.1 P5). The
// platform+referral fee is skimmed ONCE, at settlement:
//
//      feeTotal = feeShareBps × poolAtSettle / 10000
//      poolAtSettle = sponsor + cosponsor poolIn + Σ slashed stakes
//
// feeTotal is credited to the per-recipient, cross-question
// `accruedFees[recipient][token]` tab and withdrawn later via
// `withdrawFees` (§0.2). It does NOT leave the Forge ERC-20 balance at
// settlement — it just moves from the question pool bucket to the
// accrued-fees bucket. Winners take `poolAtSettle − feeTotal` via the
// merkle; winning/valid-loser stakes are refunded; slashed (orphan /
// losing) stakes were already folded into poolAtSettle (no refund, and
// the orphan earns no fee attribution — its stake just funds winners).
//
// The per-question LEDGER identity the audit reconciles (Settled):
//
//      poolInflows + Σ stakesCommitted
//        ==  Σ winnerClaims(owed)        // swept + residual still-claimable
//          + Σ stakeRefunds(owed)        // swept + escrow still-refundable
//          + feeAccrued                  // = feeTotal, whether or not swept
//
// and for Abandoned / Recovered (§0.1 P5 — no fee, everything refunded):
//
//      poolInflows + Σ stakesCommitted
//        ==  Σ refunds(owed)             // full; feeAccrued == 0
//
// The audit reconciles what is OWED, not just what has been pulled, so
// it is tolerant of money-out timing: a winner claim that is settled
// but not yet pulled still sits in the chain pool (`residualPool`),
// and a stake refund not yet pulled still sits in escrow
// (`escrowRemaining`) — both count toward the right-hand side. The fee
// is reconciled against the ACCRUED balance (the value `withdrawFees`
// would transfer, net of prior withdrawals + lifetime-withdrawn), not
// against a realized transfer, for the same reason.
//
// Across the whole battle the global invariant still holds:
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
  // accruedFees(recipient, token) — the public mapping getter. Returns
  // the exact balance withdrawFees would transfer (net of prior
  // withdrawals). Used to reconcile the settlement fee against the
  // ACCRUED ledger, not a realized transfer (the fee may not be swept
  // yet). Mirrors scripts/sweep-fees.ts::ACCRUED_FEES_ABI.
  {
    type: "function",
    name: "accruedFees",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Read the on-chain accrued (withdrawable) fee balance for a recipient.
// This is the value `withdrawFees(recipient, token)` would transfer —
// already net of prior withdrawals — so the conservation audit can
// reconcile the realized-outcome fee whether or not the sweeper has run.
export async function readAccruedFees(params: {
  publicClient: PublicClient;
  forge: Address;
  recipient: Address;
  token: Address;
}): Promise<bigint> {
  return (await params.publicClient.readContract({
    address: params.forge,
    abi: FORGE_READ_ABI,
    functionName: "accruedFees",
    args: [params.recipient, params.token],
  })) as bigint;
}

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
  /** Fee skimmed at settlement (feeShareBps × poolAtSettle), credited to
   *  accruedFees. Zero for abandoned/recovered (§0.1 P5). */
  feeAccruedTotal: bigint;
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

/** Terminal outcome of the question at audit time. Decides which side
 *  of the realized-outcome identity applies: Settled questions accrue a
 *  fee, Abandoned/Recovered ones refund everything with zero fee. */
export type QuestionOutcome = "settled" | "abandoned" | "recovered";

export interface QuestionTrace {
  scenarioId: string;
  qid: Hex;
  /** Terminal outcome. `settled` → fee at settlement; `abandoned` /
   *  `recovered` → full refund, zero fee (§0.1 P5). */
  outcome: QuestionOutcome;
  poolInflowsWei: bigint;          // sponsor + cosponsor poolIn (commit/vote fee = 0 in v2)
  stakesCommittedWei: bigint;       // every commit + vote stake locked
  // ── money-out, what's been PULLED (swept by the harness) ──
  winnerClaimsPulledWei: bigint;   // Σ merkle claim() amounts pulled to winners
  stakeRefundsPulledWei: bigint;   // Σ stake/sponsor refunds pulled
  // ── fee, ACCRUED (settlement skim; may not be withdrawn yet) ──
  // feeTotal = feeShareBps × poolAtSettle / 10000, credited to
  // accruedFees. Reconciled as accrued (= what withdrawFees would pay,
  // incl. amounts already swept), not as a realized transfer.
  feeAccruedWei: bigint;
}

// v2 realized-outcome reconciliation. `finalPool` is the question's
// on-chain `poolAmount` (getQuestionScalars index 2) read AFTER the
// money-out sweep — the still-claimable winner residual (settled-but-
// not-yet-pulled merkle leaves). `escrowRemaining` is the sum of stakes
// still locked in escrow (settled-but-not-yet-refunded). Both are
// "owed" quantities that keep the ledger balanced regardless of pull
// timing.
//
// Settled identity:
//   poolInflows + stakesCommitted
//     == winnerClaimsPulled + finalPool          (winner side: pulled + still-claimable)
//      + stakeRefundsPulled  + escrowRemaining    (stake side:  pulled + still-in-escrow)
//      + feeAccrued                               (= feeTotal, in accruedFees bucket)
//
// Abandoned / Recovered identity (no fee, full refund):
//   poolInflows + stakesCommitted
//     == stakeRefundsPulled + escrowRemaining     // sponsor + stake refunds
//      + finalPool                                // any not-yet-pulled bounty refund
//   and feeAccrued MUST be 0 (§0.1 P5).
//
// Drift ≠ 0 is a conservation violation.
export function reconcileQuestion(
  t: QuestionTrace,
  finalPool: bigint,
  escrowRemaining: bigint = 0n,
): PerQuestionAudit {
  const inflows = t.poolInflowsWei + t.stakesCommittedWei;

  const notes: string[] = [];
  // A protocol-rule violation (independent of arithmetic drift) — e.g. a
  // fee skimmed on a question that didn't settle (§0.1 P5). It must make
  // the question NOT conserve even if the ledger sum happens to balance.
  let ruleViolation = false;

  // Right-hand side: everything OWED (pulled + still-claimable +
  // still-in-escrow) + the fee accrued at settlement.
  let owedOut: bigint;
  let feeAccounted: bigint;
  if (t.outcome === "settled") {
    feeAccounted = t.feeAccruedWei;
    owedOut =
      t.winnerClaimsPulledWei +
      finalPool +
      t.stakeRefundsPulledWei +
      escrowRemaining +
      feeAccounted;
  } else {
    // Abandoned / Recovered: full refund, zero fee. A non-zero accrued
    // fee on a non-settled question is itself a defect (§0.1 P5).
    feeAccounted = 0n;
    if (t.feeAccruedWei !== 0n) {
      ruleViolation = true;
      notes.push(
        `P5 violation: ${t.outcome} question accrued fee ${t.feeAccruedWei.toString()} wei (expected 0)`,
      );
    }
    owedOut =
      t.winnerClaimsPulledWei + // 0 for non-settled, but tolerate
      finalPool +
      t.stakeRefundsPulledWei +
      escrowRemaining;
  }

  const drift = inflows - owedOut;
  if (drift !== 0n) notes.push(`ledger drift ${drift.toString()} wei`);
  const conserves = drift === 0n && !ruleViolation;
  if (notes.length === 0) notes.push("conserves");

  return {
    scenarioId: t.scenarioId,
    qid: t.qid,
    poolFundedTotal: t.poolInflowsWei,
    poolDistributed: t.winnerClaimsPulledWei + feeAccounted,
    poolResidual: finalPool,
    stakesCommittedTotal: t.stakesCommittedWei,
    stakesRefundedTotal: t.stakeRefundsPulledWei + escrowRemaining,
    stakesSlashedTotal: 0n, // slashes are folded into poolAtSettle, not a separate term
    feeAccruedTotal: feeAccounted,
    conserves,
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
