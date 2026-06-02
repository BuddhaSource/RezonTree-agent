import { describe, expect, it } from "vitest";

import {
  buildPredictionQuestion,
  computeRoundTiming,
  MIN_MARKET_WINDOW_SEC,
  selectPredictionQuestions,
  type PredictionMarket,
} from "./prediction-question.js";

const HOUR = 3600;
const NOW = 1_700_000_000;
const market = (over: Partial<PredictionMarket> = {}): PredictionMarket => ({
  id: "m1",
  question: "Will it rain in Dubai before 2027?",
  closesAt: NOW + 20 * HOUR,
  outcomes: ["Yes", "No"],
  currentProbabilities: [0.7, 0.3],
  ...over,
});

describe("computeRoundTiming", () => {
  it("accepts a market ≥18h out and closes the round a buffer before it", () => {
    const t = computeRoundTiming(NOW + 20 * HOUR, NOW);
    expect(t.ok).toBe(true);
    expect(t.roundClosesAtSec).toBe(NOW + 20 * HOUR - 2 * HOUR); // default 2h buffer
    expect(t.secondsToMarketClose).toBe(20 * HOUR);
  });

  it("rejects a market closing too soon, with a buffer-aware reason", () => {
    const t = computeRoundTiming(NOW + 5 * HOUR, NOW);
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/need ≥ 18h|run \+ settle/i);
  });

  it("honors custom min-window + buffer", () => {
    const t = computeRoundTiming(NOW + 10 * HOUR, NOW, { minWindowSec: 8 * HOUR, bufferSec: 1 * HOUR });
    expect(t.ok).toBe(true);
    expect(t.roundClosesAtSec).toBe(NOW + 10 * HOUR - 1 * HOUR);
  });

  it("MIN_MARKET_WINDOW_SEC is 18h", () => {
    expect(MIN_MARKET_WINDOW_SEC).toBe(18 * HOUR);
  });
});

describe("buildPredictionQuestion", () => {
  it("frames a probability question with shown-work criteria summing to 100", () => {
    const q = buildPredictionQuestion(market(), NOW);
    expect(q.title).toMatch(/probability that/i);
    expect(q.title).toContain("Will it rain in Dubai");
    expect(q.successCriteria).toHaveLength(3);
    expect(q.successCriteria.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(q.timing.ok).toBe(true);
  });

  it("description is ≥1000 chars and demands base rate / non-consensus / falsifiability", () => {
    const q = buildPredictionQuestion(market(), NOW);
    expect(q.description.length).toBeGreaterThanOrEqual(1000);
    expect(q.description).toMatch(/base rate/i);
    expect(q.description).toMatch(/non-consensus|price to BEAT/i);
    expect(q.description).toMatch(/falsif/i);
  });

  it("renders the current market view when probabilities are provided", () => {
    const q = buildPredictionQuestion(market({ currentProbabilities: [0.7, 0.3] }), NOW);
    expect(q.description).toMatch(/Yes 70% · No 30%/);
  });

  it("flags timing.ok=false for a market closing too soon (caller skips it)", () => {
    const q = buildPredictionQuestion(market({ closesAt: NOW + 4 * HOUR }), NOW);
    expect(q.timing.ok).toBe(false);
  });
});

describe("selectPredictionQuestions", () => {
  it("keeps only timing-ok markets and caps at limit", () => {
    const markets = [
      market({ id: "ok1", closesAt: NOW + 20 * HOUR }),
      market({ id: "soon", closesAt: NOW + 4 * HOUR }), // timing.ok=false → skipped
      market({ id: "ok2", closesAt: NOW + 22 * HOUR }),
    ];
    expect(selectPredictionQuestions(markets, NOW, { limit: 1 }).map((p) => p.market.id)).toEqual(["ok1"]);
    expect(selectPredictionQuestions(markets, NOW).map((p) => p.market.id)).toEqual(["ok1", "ok2"]);
  });
  it("returns [] when no market fits the round-timing window", () => {
    expect(selectPredictionQuestions([market({ closesAt: NOW + 2 * HOUR })], NOW)).toEqual([]);
  });
});
