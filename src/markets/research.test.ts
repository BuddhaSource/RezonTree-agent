import { describe, expect, it } from "vitest";

import type { PredictionMarket } from "./prediction-question.js";
import type { MarketSource } from "./polymarket.js";
import {
  formatMarketBrief,
  gatherMarketResearch,
  marketFactSheet,
} from "./research.js";

const NOW = 1_750_000_000; // fixed snapshot
const HOUR = 3600;

const sample: PredictionMarket = {
  id: "m1",
  question: "Will X happen by Friday?",
  closesAt: NOW + 20 * HOUR,
  outcomes: ["Yes", "No"],
  currentProbabilities: [0.62, 0.38],
};

function mockSource(markets: PredictionMarket[]): MarketSource {
  return {
    name: "mock",
    fetchClosingMarkets: async () => markets,
  };
}

describe("market research helpers", () => {
  it("marketFactSheet surfaces the verbatim question, close time, and current odds", () => {
    const facts = marketFactSheet(sample, NOW);
    expect(facts.some((f) => f.includes("Will X happen by Friday?"))).toBe(true);
    expect(facts.some((f) => f.includes("62.0%") && f.includes("38.0%"))).toBe(
      true,
    );
    // Anti-slop: explicitly marks the odds as a snapshot to re-verify.
    expect(facts.some((f) => /snapshot|re-verify/i.test(f))).toBe(true);
  });

  it("marketFactSheet reports unknown odds rather than inventing a number", () => {
    const noOdds: PredictionMarket = { ...sample, currentProbabilities: undefined };
    const facts = marketFactSheet(noOdds, NOW);
    expect(facts.some((f) => f.includes("unknown"))).toBe(true);
  });

  it("gatherMarketResearch enriches each market with facts + round timing", async () => {
    const research = await gatherMarketResearch({
      nowSec: NOW,
      source: mockSource([sample]),
    });
    expect(research).toHaveLength(1);
    expect(research[0].market.id).toBe("m1");
    expect(research[0].timing.ok).toBe(true); // 20h out ≥ 18h window
    // round closes before the market (buffer applied)
    expect(research[0].timing.roundClosesAtSec).toBeLessThan(sample.closesAt);
    expect(research[0].facts.length).toBeGreaterThan(0);
  });

  it("formatMarketBrief leads with the cite-the-facts instruction and lists each market", () => {
    const research = [
      {
        market: sample,
        timing: { ok: true, roundClosesAtSec: sample.closesAt - 2 * HOUR, secondsToMarketClose: 20 * HOUR },
        facts: marketFactSheet(sample, NOW),
      },
    ];
    const md = formatMarketBrief(research, NOW);
    expect(md).toMatch(/never invent a/i);
    expect(md).toContain("Will X happen by Friday?");
  });

  it("formatMarketBrief handles an empty window without inventing content", () => {
    const md = formatMarketBrief([], NOW);
    expect(md).toMatch(/No markets in the closing window/i);
  });
});
