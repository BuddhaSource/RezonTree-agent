import { describe, expect, it } from "vitest";

import { scoreSolutions, MIN_ARGUMENT_CHARS, type VoteCriterion, type VoteSolution } from "./matrix.js";

const criteria: VoteCriterion[] = [
  { id: "c1", name: "depth", weight: 40 },
  { id: "c2", name: "completeness", weight: 35 },
  { id: "c3", name: "falsifiability", weight: 25 },
];

const ARG = "x".repeat(MIN_ARGUMENT_CHARS); // a substantive (>= floor) argument
const STUB = "too short"; // below the floor → not a real argument

const sol = (intentHash: string, stakeWei: bigint, claims: VoteSolution["claims"]): VoteSolution => ({
  intentHash,
  author: "0xabc",
  stakeWei,
  claims,
});

describe("scoreSolutions", () => {
  const solA = sol("A", 5n, [
    { criterionId: "c1", argument: ARG, falsifiableBy: "rerun" },
    { criterionId: "c2", argument: ARG, falsifiableBy: "rerun" },
    { criterionId: "c3", argument: ARG, falsifiableBy: "rerun" },
  ]); // all full → 100
  const solB = sol("B", 10n, [
    { criterionId: "c1", argument: ARG, falsifiableBy: "rerun" }, // full → 40
    { criterionId: "c2", argument: STUB }, // claim-only (stub arg, no fals) → 35*0.4 = 14
    // c3 missing → 0, uncovered
  ]);
  const solC = sol("C", 1n, [
    { criterionId: "c1", argument: STUB },
    { criterionId: "c2", argument: STUB },
    { criterionId: "c3", argument: STUB },
  ]); // all claim-only → 0.4 each → 40

  const m = scoreSolutions(criteria, [solB, solA, solC]);

  it("scores full coverage at 100 and a stub-only solution at 40", () => {
    const a = m.ranked.find((s) => s.intentHash === "A")!;
    const c = m.ranked.find((s) => s.intentHash === "C")!;
    expect(a.total).toBe(100);
    expect(c.total).toBe(40);
  });

  it("forfeits the weight of an uncovered criterion", () => {
    const b = m.ranked.find((s) => s.intentHash === "B")!;
    expect(b.uncovered).toBe(1); // c3 missing
    expect(b.total).toBe(54); // 40*1 + 35*0.4 + 0
  });

  it("ranks by structural score (winner first)", () => {
    expect(m.ranked.map((s) => s.intentHash)).toEqual(["A", "B", "C"]);
  });

  it("reads in stake order, highest first", () => {
    expect(m.readOrder.map((s) => s.intentHash)).toEqual(["B", "A", "C"]); // 10 > 5 > 1
  });

  it("a substantive argument + falsifiable scores the criterion 1.0; claim-only scores 0.4", () => {
    const a = m.ranked.find((s) => s.intentHash === "A")!;
    expect(a.perCriterion[0].completeness).toBe(1);
    const c = m.ranked.find((s) => s.intentHash === "C")!;
    expect(c.perCriterion[0].completeness).toBe(0.4); // claim present, stub arg, no falsifiable
  });
});
