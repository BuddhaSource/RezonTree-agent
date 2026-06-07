import { describe, expect, it } from "vitest";

import {
  filterClosingWindow,
  parseGammaMarket,
  polymarketSource,
  polymarketUrl,
} from "./polymarket.js";
import type { PredictionMarket } from "./prediction-question.js";

const HOUR = 3600;
const NOW = 1_700_000_000;
const iso = (hoursFromNow: number) => new Date((NOW + hoursFromNow * HOUR) * 1000).toISOString();

const gamma = (over: Record<string, unknown> = {}) => ({
  conditionId: "0xcond1",
  question: "Will X happen by Friday?",
  closed: false,
  active: true,
  endDate: iso(20),
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.7","0.3"]',
  slug: "will-x-by-friday",
  events: [{ slug: "what-happens-by-friday" }],
  ...over,
});

describe("parseGammaMarket", () => {
  it("normalizes an open binary market (JSON-string outcomes/prices)", () => {
    const m = parseGammaMarket(gamma());
    expect(m).not.toBeNull();
    expect(m!.id).toBe("0xcond1");
    expect(m!.question).toBe("Will X happen by Friday?");
    expect(m!.closesAt).toBe(NOW + 20 * HOUR);
    expect(m!.outcomes).toEqual(["Yes", "No"]);
    expect(m!.currentProbabilities).toEqual([0.7, 0.3]);
    // URL is derived from the EVENT slug (the public page), not the market slug.
    expect(m!.url).toBe("https://polymarket.com/event/what-happens-by-friday");
  });

  it("rejects resolved / inactive / malformed markets", () => {
    expect(parseGammaMarket(gamma({ closed: true }))).toBeNull();
    expect(parseGammaMarket(gamma({ active: false }))).toBeNull();
    expect(parseGammaMarket(gamma({ endDate: undefined }))).toBeNull();
    expect(parseGammaMarket(gamma({ endDate: "not-a-date" }))).toBeNull();
    expect(parseGammaMarket(gamma({ outcomes: '["OnlyOne"]' }))).toBeNull();
    expect(parseGammaMarket(null)).toBeNull();
  });

  it("omits currentProbabilities when prices don't line up with outcomes", () => {
    const m = parseGammaMarket(gamma({ outcomePrices: '["0.7"]' })); // 1 price, 2 outcomes
    expect(m!.currentProbabilities).toBeUndefined();
  });
});

describe("polymarketUrl", () => {
  it("prefers the event slug, falls back to the market slug, else undefined", () => {
    expect(polymarketUrl({ slug: "m", events: [{ slug: "ev" }] })).toBe(
      "https://polymarket.com/event/ev",
    );
    expect(polymarketUrl({ slug: "m" })).toBe("https://polymarket.com/event/m");
    expect(polymarketUrl({ events: [{}] })).toBeUndefined();
    expect(polymarketUrl({})).toBeUndefined();
  });
});

describe("filterClosingWindow", () => {
  const mk = (h: number): PredictionMarket => ({ id: `m${h}`, question: "q", closesAt: NOW + h * HOUR, outcomes: ["Yes", "No"] });
  it("keeps only markets closing within [minHours, maxHours]", () => {
    const kept = filterClosingWindow([mk(5), mk(20), mk(23), mk(30)], { nowSec: NOW });
    expect(kept.map((m) => m.id)).toEqual(["m20", "m23"]); // default 18-24h: drops 5h + 30h
  });
  it("honors custom window bounds", () => {
    const kept = filterClosingWindow([mk(5), mk(10)], { nowSec: NOW, minHours: 4, maxHours: 8 });
    expect(kept.map((m) => m.id)).toEqual(["m5"]);
  });
});

describe("polymarketSource", () => {
  it("fetches, parses + windows (array response) via injected fetchJson", async () => {
    const fetchJson = async () => [gamma({ conditionId: "in", endDate: iso(20) }), gamma({ conditionId: "soon", endDate: iso(3) }), gamma({ conditionId: "closed", closed: true })];
    const src = polymarketSource(fetchJson);
    const out = await src.fetchClosingMarkets({ nowSec: NOW });
    expect(src.name).toBe("polymarket");
    expect(out.map((m) => m.id)).toEqual(["in"]); // soon (3h) windowed out; closed parsed-null
  });

  it("handles a {data:[...]} envelope response", async () => {
    const fetchJson = async () => ({ data: [gamma({ conditionId: "in" })] });
    const out = await polymarketSource(fetchJson).fetchClosingMarkets({ nowSec: NOW });
    expect(out.map((m) => m.id)).toEqual(["in"]);
  });
});
