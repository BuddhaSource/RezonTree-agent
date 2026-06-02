// polymarket.ts — a MarketSource that pulls Polymarket (Gamma API) markets
// closing soon and normalizes them to the generic PredictionMarket the
// prediction-question builder consumes.
//
// The network fetch is injected (`fetchJson`) so the adapter tests offline; the
// two load-bearing transforms — parse one Gamma market, and filter to the
// closing window — are PURE and unit-tested against mocked Gamma JSON. Gamma
// encodes `outcomes` / `outcomePrices` as JSON-string arrays and marks resolved
// markets `closed:true`; we handle both + skip anything unusable.

import type { PredictionMarket } from "./prediction-question.js";

const HOUR = 3600;
export const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";

export interface ClosingWindowOpts {
  /** unix seconds "now" (injected for deterministic tests). */
  nowSec: number;
  /** Earliest close, hours from now (default 18 — leaves room to run + settle). */
  minHours?: number;
  /** Latest close, hours from now (default 24). */
  maxHours?: number;
}

/** A source of prediction markets. Polymarket is one; others (Kalshi, Manifold)
 *  can implement the same interface and feed the same prediction-question path. */
export interface MarketSource {
  readonly name: string;
  fetchClosingMarkets(opts: ClosingWindowOpts): Promise<PredictionMarket[]>;
}

/** Raw Gamma fields we read (others ignored). */
interface GammaMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  closed?: boolean;
  active?: boolean;
  endDate?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
}

/** Gamma sends arrays as JSON-encoded strings (e.g. '["Yes","No"]'); accept
 *  either a real array or that string form, else []. */
function parseJsonArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const a = JSON.parse(v) as unknown;
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Pure: one Gamma market → PredictionMarket, or null when it isn't a usable
 *  open market (resolved, inactive, missing question/endDate, <2 outcomes, or
 *  an unparseable date). currentProbabilities is set only when the price array
 *  lines up with the outcomes and parses to finite numbers. */
export function parseGammaMarket(m: GammaMarket | null | undefined): PredictionMarket | null {
  if (!m || m.closed === true || m.active === false) return null;
  if (!m.question || !m.endDate) return null;
  const ms = Date.parse(m.endDate);
  if (!Number.isFinite(ms)) return null;
  const outcomes = parseJsonArray(m.outcomes);
  if (outcomes.length < 2) return null;
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  const currentProbabilities =
    prices.length === outcomes.length && prices.every((p) => Number.isFinite(p)) ? prices : undefined;
  const id = String(m.conditionId ?? m.id ?? "");
  if (!id) return null;
  return { id, question: m.question, closesAt: Math.floor(ms / 1000), outcomes, currentProbabilities };
}

/** Pure: keep only markets closing within [minHours, maxHours] from now. */
export function filterClosingWindow(
  markets: PredictionMarket[],
  opts: ClosingWindowOpts,
): PredictionMarket[] {
  const lo = opts.nowSec + (opts.minHours ?? 18) * HOUR;
  const hi = opts.nowSec + (opts.maxHours ?? 24) * HOUR;
  return markets.filter((m) => m.closesAt >= lo && m.closesAt <= hi);
}

export type FetchJson = (url: string) => Promise<unknown>;

/** Build a Polymarket MarketSource. `fetchJson` is injected (the runner wires
 *  it to fetch; tests pass a mock). Pulls open markets and returns those in the
 *  closing window, normalized. */
export function polymarketSource(fetchJson: FetchJson): MarketSource {
  return {
    name: "polymarket",
    async fetchClosingMarkets(opts: ClosingWindowOpts): Promise<PredictionMarket[]> {
      const raw = await fetchJson(`${GAMMA_MARKETS_URL}?closed=false&active=true&limit=200`);
      const list = Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? []);
      const parsed = (list as GammaMarket[])
        .map(parseGammaMarket)
        .filter((m): m is PredictionMarket => m !== null);
      return filterClosingWindow(parsed, opts);
    },
  };
}
