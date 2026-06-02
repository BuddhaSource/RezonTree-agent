import { describe, expect, it } from "vitest";

import {
  scoreCredibility,
  scoreSolutionCredibility,
  EVIDENCE_NUMBER_TARGET,
  SLOP_RATIO_CEILING,
} from "./credibility.js";
import type { VoteSolution } from "./matrix.js";

const EVIDENCE_BACKED =
  "The base rate is 12% over 30 days (2023). Versus the market price of 0.18, " +
  "this is < the historical mean, so I estimate P = 0.14 per et al. analysis.";

const SLOP =
  "It is important to note that this is a multifaceted issue. In conclusion, " +
  "at the end of the day, this plays a crucial role in our ever-evolving world. I hope this helps.";

const MIXED = "The figure is 0.3 and the trend is 0.5 over the window.";

describe("scoreCredibility", () => {
  it("scores quantitative, cited, operator-rich text as evidence-backed", () => {
    const s = scoreCredibility(EVIDENCE_BACKED);
    expect(s.signals.numberCount).toBeGreaterThanOrEqual(EVIDENCE_NUMBER_TARGET);
    expect(s.signals.hasCitation).toBe(true); // (2023) + et al.
    expect(s.signals.hasOperator).toBe(true); // "<" and "per"/"Versus"
    expect(s.evidence).toBe(1);
    expect(s.verdict).toBe("evidence-backed");
  });

  it("scores filler-heavy prose with no anchors as slop (credibility 0)", () => {
    const s = scoreCredibility(SLOP);
    expect(s.signals.slopMarkers).toBe(7); // 7 distinct filler phrases
    expect(s.evidence).toBe(0);
    expect(s.slop).toBe(1);
    expect(s.credibility).toBe(0);
    expect(s.verdict).toBe("slop");
  });

  it("scores a plain quantitative sentence with no filler as mixed", () => {
    const s = scoreCredibility(MIXED);
    expect(s.signals.slopMarkers).toBe(0);
    expect(s.slop).toBe(0);
    expect(s.credibility).toBeGreaterThan(0.2);
    expect(s.credibility).toBeLessThan(0.6);
    expect(s.verdict).toBe("mixed");
  });

  it("suppresses slop multiplicatively: credibility = evidence × (1 − slop)", () => {
    const s = scoreCredibility(EVIDENCE_BACKED);
    expect(s.credibility).toBeCloseTo(s.evidence * (1 - s.slop), 10);
    // a numbered sentence diluted with filler scores below its raw evidence
    const diluted = scoreCredibility(
      "It is important to note, in conclusion, that the rate is 12% and 0.3 and 0.5.",
    );
    expect(diluted.slop).toBeGreaterThan(0);
    expect(diluted.credibility).toBeLessThan(diluted.evidence);
  });

  it("treats empty text as zero credibility", () => {
    const s = scoreCredibility("");
    expect(s.signals.wordCount).toBe(0);
    expect(s.credibility).toBe(0);
  });

  it("counts a repeated filler phrase each time it occurs", () => {
    expect(scoreCredibility("in summary, in summary").signals.slopMarkers).toBe(2);
  });

  it("SLOP_RATIO_CEILING anchors the fully-slop threshold", () => {
    expect(SLOP_RATIO_CEILING).toBe(3);
  });
});

describe("scoreSolutionCredibility", () => {
  const sol: VoteSolution = {
    intentHash: "S1",
    author: "0xabc",
    stakeWei: 10n,
    claims: [
      { criterionId: "c1", argument: EVIDENCE_BACKED }, // ~1.0
      { criterionId: "c2", argument: SLOP }, // 0
      { criterionId: "c3" }, // no argument — excluded from the mean
    ],
  };

  it("averages only claims that carry an argument", () => {
    const r = scoreSolutionCredibility(sol);
    expect(r.perCriterion).toHaveLength(3);
    // mean of c1 (1.0) and c2 (0) = 0.5; c3 (empty) excluded
    expect(r.aggregate).toBeCloseTo(0.5, 10);
    expect(r.verdict).toBe("mixed");
  });

  it("aggregate is 0 when no claim carries an argument", () => {
    const empty: VoteSolution = { intentHash: "S2", author: "0x0", stakeWei: 1n, claims: [{ criterionId: "c1" }] };
    const r = scoreSolutionCredibility(empty);
    expect(r.aggregate).toBe(0);
    expect(r.verdict).toBe("slop");
  });
});
