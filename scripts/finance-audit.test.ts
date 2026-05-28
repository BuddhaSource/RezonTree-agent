// finance-audit.test.ts — unit coverage for the realized-outcome
// conservation invariant (docs/economics.md §0). This is on the
// live-swarm path (run-battle.ts → reconcileQuestion), so a wrong
// invariant throws FALSE reconciliation failures during a swarm. The
// cases below mirror the §0.4 TDD matrix.

import { describe, expect, it } from "vitest";

import {
  type QuestionTrace,
  reconcileQuestion,
} from "./finance-audit.js";

// Base trace builder — a settled question with one sponsor, no money
// movement. Override per case.
function trace(over: Partial<QuestionTrace> = {}): QuestionTrace {
  return {
    scenarioId: "t",
    qid: "0x00" as QuestionTrace["qid"],
    outcome: "settled",
    poolInflowsWei: 0n,
    stakesCommittedWei: 0n,
    winnerClaimsPulledWei: 0n,
    stakeRefundsPulledWei: 0n,
    feeAccruedWei: 0n,
    ...over,
  };
}

describe("reconcileQuestion — realized-outcome model", () => {
  it("settled, fully swept: winners claim pool−fee, stakes refunded, fee accrued", () => {
    // poolAtSettle = 1_000_000 sponsor (no slashing here).
    // feeShareBps = 10% → feeTotal = 100_000.
    // winners claim 900_000; one solver stake (50_000) refunded.
    const a = reconcileQuestion(
      trace({
        poolInflowsWei: 1_000_000n,
        stakesCommittedWei: 50_000n,
        winnerClaimsPulledWei: 900_000n,
        stakeRefundsPulledWei: 50_000n,
        feeAccruedWei: 100_000n,
      }),
      0n, // finalPool: everything pulled
      0n, // escrowRemaining: everything refunded
    );
    expect(a.conserves).toBe(true);
    expect(a.drift).toBe(0n);
    expect(a.feeAccruedTotal).toBe(100_000n);
  });

  it("settled with a slashed loser: slashed stake folds into poolAtSettle, exits via winner claim + fee", () => {
    // sponsor 1_000_000; two solvers stake 100_000 each.
    // loser slashed → poolAtSettle = 1_000_000 + 100_000 = 1_100_000.
    // feeShareBps 10% → feeTotal = 110_000; winners claim 990_000.
    // winner's own stake (100_000) refunded; loser's is NOT (slashed).
    const a = reconcileQuestion(
      trace({
        poolInflowsWei: 1_000_000n,
        stakesCommittedWei: 200_000n, // both stakes locked
        winnerClaimsPulledWei: 990_000n,
        stakeRefundsPulledWei: 100_000n, // only the winner's stake back
        feeAccruedWei: 110_000n,
      }),
      0n,
      0n,
    );
    // in 1_200_000 = out 990_000 + 100_000 + 110_000 = 1_200_000.
    expect(a.conserves).toBe(true);
    expect(a.drift).toBe(0n);
  });

  it("settled but claim NOT yet pulled: residual sits in chain pool, still balances", () => {
    // Same as case 1 but the winner claim hasn't been pulled — it
    // remains in finalPool. Ledger reconciles owed, so still 0 drift.
    const a = reconcileQuestion(
      trace({
        poolInflowsWei: 1_000_000n,
        stakesCommittedWei: 50_000n,
        winnerClaimsPulledWei: 0n, // not pulled
        stakeRefundsPulledWei: 50_000n,
        feeAccruedWei: 100_000n,
      }),
      900_000n, // finalPool: still-claimable winner residual
      0n,
    );
    expect(a.conserves).toBe(true);
    expect(a.drift).toBe(0n);
  });

  it("settled but stake refund NOT yet pulled: sits in escrow, still balances", () => {
    const a = reconcileQuestion(
      trace({
        poolInflowsWei: 1_000_000n,
        stakesCommittedWei: 50_000n,
        winnerClaimsPulledWei: 900_000n,
        stakeRefundsPulledWei: 0n, // not pulled
        feeAccruedWei: 100_000n,
      }),
      0n,
      50_000n, // escrowRemaining: still-refundable stake
    );
    expect(a.conserves).toBe(true);
    expect(a.drift).toBe(0n);
  });

  it("settled but fee NOT yet withdrawn: accrued reconciles, not the transfer", () => {
    // The fee was accrued at settlement (feeAccruedWei = 100_000) even
    // though the sweeper hasn't pulled it. The audit counts accrued, so
    // no drift — exactly the timing tolerance the swarm needs.
    const a = reconcileQuestion(
      trace({
        poolInflowsWei: 1_000_000n,
        stakesCommittedWei: 0n,
        winnerClaimsPulledWei: 900_000n,
        stakeRefundsPulledWei: 0n,
        feeAccruedWei: 100_000n, // accrued, not yet swept
      }),
      0n,
      0n,
    );
    expect(a.conserves).toBe(true);
    expect(a.feeAccruedTotal).toBe(100_000n);
  });

  it("abandoned: everything refunded, zero fee (§0.1 P5)", () => {
    // No solutions → sponsor + any stakes fully refunded; no fee.
    const a = reconcileQuestion(
      trace({
        outcome: "abandoned",
        poolInflowsWei: 1_000_000n,
        stakesCommittedWei: 0n,
        winnerClaimsPulledWei: 0n,
        stakeRefundsPulledWei: 1_000_000n,
        feeAccruedWei: 0n,
      }),
      0n,
      0n,
    );
    expect(a.conserves).toBe(true);
    expect(a.feeAccruedTotal).toBe(0n);
  });

  it("recovered (post-deadline): full refund, zero fee", () => {
    const a = reconcileQuestion(
      trace({
        outcome: "recovered",
        poolInflowsWei: 500_000n,
        stakesCommittedWei: 30_000n,
        stakeRefundsPulledWei: 530_000n,
        feeAccruedWei: 0n,
      }),
      0n,
      0n,
    );
    expect(a.conserves).toBe(true);
  });

  it("abandoned with a NON-zero accrued fee is a P5 violation", () => {
    // A fee should never be skimmed on a question that didn't settle.
    const a = reconcileQuestion(
      trace({
        outcome: "abandoned",
        poolInflowsWei: 1_000_000n,
        stakeRefundsPulledWei: 1_000_000n,
        feeAccruedWei: 1n, // illegal
      }),
      0n,
      0n,
    );
    expect(a.conserves).toBe(false);
    expect(a.notes.some((n) => n.includes("P5 violation"))).toBe(true);
  });

  it("genuine shortfall (funds missing) drifts non-zero", () => {
    // poolAtSettle 1_000_000, fee 100_000, but only 800_000 claimed and
    // nothing left in the pool or escrow — 100_000 vanished.
    const a = reconcileQuestion(
      trace({
        poolInflowsWei: 1_000_000n,
        winnerClaimsPulledWei: 800_000n,
        feeAccruedWei: 100_000n,
      }),
      0n,
      0n,
    );
    expect(a.conserves).toBe(false);
    expect(a.drift).toBe(100_000n);
    expect(a.notes.some((n) => n.includes("ledger drift"))).toBe(true);
  });
});
