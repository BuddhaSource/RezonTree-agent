// budget/index.test.ts — the spend-governor arithmetic.
//
// No Date.now / Math.random: the budget is pure, so every assertion is a
// fixed input → fixed output. Covers the cap/spent/remaining math, the
// canAfford boundary, record accumulation, exhausted with + without a floor,
// the createBudget guard, and budgetFromEnv's parse + null path.

import { afterEach, describe, expect, it } from "vitest";

import { budgetFromEnv, createBudget } from "./index.js";

describe("createBudget", () => {
  it("starts at zero spend with the given cap", () => {
    const b = createBudget(10);
    expect(b.capUsd).toBe(10);
    expect(b.spentUsd).toBe(0);
    expect(b.remainingUsd()).toBe(10);
  });

  it("throws on a zero or negative cap", () => {
    expect(() => createBudget(0)).toThrow(/positive/);
    expect(() => createBudget(-5)).toThrow(/positive/);
  });

  it("throws on a non-finite cap", () => {
    expect(() => createBudget(Number.NaN)).toThrow(/positive/);
    expect(() => createBudget(Number.POSITIVE_INFINITY)).toThrow(/positive/);
  });
});

describe("remaining / record accumulation", () => {
  it("subtracts cumulative spend from the cap", () => {
    const b = createBudget(10);
    b.record(3);
    expect(b.spentUsd).toBe(3);
    expect(b.remainingUsd()).toBe(7);
    b.record(2);
    expect(b.spentUsd).toBe(5);
    expect(b.remainingUsd()).toBe(5);
  });

  it("clamps remaining at zero, never negative, after overspend", () => {
    const b = createBudget(5);
    b.record(4);
    b.record(4); // total 8 > cap 5
    expect(b.spentUsd).toBe(8);
    expect(b.remainingUsd()).toBe(0);
  });

  it("does not drift on fractional accumulation (cent rounding)", () => {
    const b = createBudget(1);
    for (let i = 0; i < 10; i++) b.record(0.1); // 10 × $0.10 = $1.00 exactly
    expect(b.spentUsd).toBe(1);
    expect(b.remainingUsd()).toBe(0);
  });

  it("rejects a negative record", () => {
    const b = createBudget(10);
    expect(() => b.record(-1)).toThrow(/non-negative/);
  });
});

describe("canAfford boundaries", () => {
  it("affords exactly the remaining amount, not a cent more", () => {
    const b = createBudget(10);
    b.record(7); // remaining 3
    expect(b.canAfford(3)).toBe(true); // exact fit
    expect(b.canAfford(3.01)).toBe(false); // one cent over
    expect(b.canAfford(2.99)).toBe(true);
  });

  it("affords a zero-cost action even when exhausted", () => {
    const b = createBudget(5);
    b.record(5);
    expect(b.remainingUsd()).toBe(0);
    expect(b.canAfford(0)).toBe(true);
    expect(b.canAfford(0.5)).toBe(false);
  });
});

describe("exhausted", () => {
  it("without a floor, exhausted compares remaining < 0 — never true since remaining clamps at 0", () => {
    // Spec: exhausted(floorUsd?) === remaining < (floorUsd ?? 0). With floor 0
    // and a remaining that clamps at 0, this is always false. The MEANINGFUL
    // stop check always passes a floor (the cheapest action's cost); the
    // no-floor form is the degenerate "is remaining literally negative" probe.
    const b = createBudget(5);
    expect(b.exhausted()).toBe(false);
    b.record(5); // remaining 0
    expect(b.exhausted()).toBe(false); // 0 < 0 is false
  });

  it("with a floor, exhausted once remaining drops below the cheapest action", () => {
    const b = createBudget(5);
    b.record(4.5); // remaining 0.50
    expect(b.exhausted(0.5)).toBe(false); // 0.50 >= 0.50 → still afford the floor
    expect(b.exhausted(1)).toBe(true); // 0.50 < 1.00 → can't afford the cheapest action
  });

  it("a fresh budget below its own floor is exhausted immediately", () => {
    const b = createBudget(0.4);
    expect(b.exhausted(0.5)).toBe(true);
  });
});

describe("budgetFromEnv", () => {
  const PRIOR = process.env.RT_BUDGET_USD;
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.RT_BUDGET_USD;
    else process.env.RT_BUDGET_USD = PRIOR;
  });

  it("returns null when RT_BUDGET_USD is unset", () => {
    delete process.env.RT_BUDGET_USD;
    expect(budgetFromEnv()).toBeNull();
  });

  it("returns null when RT_BUDGET_USD is blank", () => {
    process.env.RT_BUDGET_USD = "   ";
    expect(budgetFromEnv()).toBeNull();
  });

  it("parses RT_BUDGET_USD into a capped budget", () => {
    process.env.RT_BUDGET_USD = "10";
    const b = budgetFromEnv();
    expect(b).not.toBeNull();
    expect(b?.capUsd).toBe(10);
    expect(b?.remainingUsd()).toBe(10);
  });

  it("throws on a set-but-invalid cap (fails fast, never runs uncapped)", () => {
    process.env.RT_BUDGET_USD = "0";
    expect(() => budgetFromEnv()).toThrow(/positive/);
    process.env.RT_BUDGET_USD = "not-a-number";
    expect(() => budgetFromEnv()).toThrow(/positive/);
  });
});
