// markets/research.ts — prediction-market research helpers any agent can use
// to explore markets before authoring a question or working a solution.
//
// Builds on the Polymarket adapter (polymarket.ts) + the round-timing math
// (prediction-question.ts). The point is FACTUAL grounding: gatherMarketResearch
// returns the REAL numbers — resolution question verbatim, close time, outcomes,
// current market-implied probabilities — as a citable fact sheet, so an agent
// grounds its question/solution in data it actually fetched instead of inventing
// it. The companion anti-slop prompt rule (src/prompts) tells the agent to cite
// these facts and never fabricate a probability or a source.

import {
  computeRoundTiming,
  type PredictionMarket,
  type RoundTiming,
} from "./prediction-question.js";
import {
  polymarketSource,
  type FetchJson,
  type MarketSource,
} from "./polymarket.js";

const HOUR = 3600;

/** A market enriched with the facts an agent should cite + the RezonTree
 *  round-timing (the round must close before the market resolves). */
export interface MarketResearch {
  market: PredictionMarket;
  timing: RoundTiming;
  /** Compact factual lines an agent must cite verbatim — no fabrication. */
  facts: string[];
}

/** Live fetch wrapper (tests inject their own fetchJson). Throws on non-2xx so
 *  a flaky source surfaces loudly rather than silently returning slop. */
export const realFetchJson: FetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`market fetch ${res.status} ${url}`);
  return res.json();
};

function pct(p: number | undefined): string {
  return p === undefined ? "unknown" : `${(p * 100).toFixed(1)}%`;
}

/** Citable fact sheet for one market — the exact data an agent grounds its
 *  content in. Probabilities are the market's CURRENT implied odds; flag them
 *  as a snapshot so the agent dates the claim. */
export function marketFactSheet(m: PredictionMarket, nowSec: number): string[] {
  const hoursToClose = ((m.closesAt - nowSec) / HOUR).toFixed(1);
  const odds = m.outcomes
    .map((o, i) => `${o} ${pct(m.currentProbabilities?.[i])}`)
    .join(" · ");
  return [
    `Market (verbatim): ${m.question}`,
    `Resolves: ${new Date(m.closesAt * 1000).toISOString()} (~${hoursToClose}h from snapshot)`,
    `Outcomes + current market-implied odds: ${odds}`,
    `Source: Polymarket — re-verify before citing; odds are a point-in-time snapshot, not a guarantee`,
  ];
}

export interface ResearchOpts {
  /** Unix seconds "now" (injected for deterministic use/tests). */
  nowSec: number;
  /** Closing window, hours from now (default 18..24 — leaves room to run + settle). */
  minHours?: number;
  maxHours?: number;
  /** Market source — defaults to Polymarket. Any MarketSource works. */
  source?: MarketSource;
  /** Fetch override (tests). Ignored when `source` is supplied. */
  fetchJson?: FetchJson;
}

/** The one call an agent makes to explore "what prediction markets could I turn
 *  into a question — or research a solution for — right now?" Returns each
 *  market in the closing window enriched with its fact sheet + round timing. */
export async function gatherMarketResearch(
  opts: ResearchOpts,
): Promise<MarketResearch[]> {
  const source = opts.source ?? polymarketSource(opts.fetchJson ?? realFetchJson);
  const markets = await source.fetchClosingMarkets({
    nowSec: opts.nowSec,
    minHours: opts.minHours,
    maxHours: opts.maxHours,
  });
  return markets.map((market) => ({
    market,
    timing: computeRoundTiming(market.closesAt, opts.nowSec),
    facts: marketFactSheet(market, opts.nowSec),
  }));
}

/** Markdown brief for the agent working directory's research/ folder. Leads
 *  with the cite-the-facts instruction so whoever reads the file (human or a
 *  downstream LLM turn) grounds content in it. */
export function formatMarketBrief(
  research: MarketResearch[],
  nowSec: number,
): string {
  const lines = [
    `# Prediction-market research — ${new Date(nowSec * 1000).toISOString()}`,
    "",
  ];
  if (research.length === 0) {
    lines.push(
      "_No markets in the closing window. Widen the hours range or retry later._",
    );
    return lines.join("\n");
  }
  lines.push(
    `${research.length} market(s) in the closing window. Ground any question or`,
    `solution in these facts — cite the actual odds + close time, never invent a`,
    `number or a source.`,
    "",
  );
  for (const r of research) {
    lines.push(`## ${r.market.question}`);
    for (const f of r.facts) lines.push(`- ${f}`);
    lines.push(
      `- RezonTree round must close by: ${new Date(
        r.timing.roundClosesAtSec * 1000,
      ).toISOString()}${r.timing.ok ? "" : ` (⚠ ${r.timing.reason})`}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
