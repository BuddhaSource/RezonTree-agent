// prediction-question.ts — turn a prediction market into a RezonTree question
// that crowdsources calibrated outcome-probability reasoning.
//
// Two pure pieces (both unit-tested; Loop 17's Polymarket adapter produces the
// PredictionMarket this consumes):
//   • computeRoundTiming — the RezonTree round must CLOSE BEFORE the market
//     resolves, so the crowdsourced probability is settled in time to act on.
//     We recommend markets ≥18-24h out and close the round a buffer (default 2h)
//     before the market, leaving room for the round to run + settle. Markets
//     closing too soon are rejected.
//   • buildPredictionQuestion — frame the market as a question that elicits a
//     NUMERIC probability with calibrated, evidence-grounded, non-consensus
//     reasoning (the prediction quality lens), with 3 criteria that reward
//     shown work over a confident guess.

/** Generic prediction market — the shape every MarketSource normalizes to
 *  (Loop 17's Polymarket adapter, and any future source). */
export interface PredictionMarket {
  id: string;
  /** The market's resolution question, verbatim. */
  question: string;
  /** Unix seconds at which the market resolves. */
  closesAt: number;
  /** Outcome labels, e.g. ["Yes", "No"]. */
  outcomes: string[];
  /** Current market-implied probabilities per outcome (0..1), if known. */
  currentProbabilities?: number[];
  /** Public URL of the market this question/solution researches against.
   *  REQUIRED context: every prediction question carries it in the body and
   *  every solution must cite it (see buildPredictionQuestion + the scaffolds).
   *  Optional only because a non-Polymarket source might not expose one. */
  url?: string;
}

const HOUR = 3600;
/** Don't touch markets resolving sooner than this — the round needs time to run
 *  (solutions + voting + settle) before the market resolves. */
export const MIN_MARKET_WINDOW_SEC = 18 * HOUR;
/** Close the RezonTree round this far ahead of the market so settlement + any
 *  downstream action lands before resolution. */
export const DEFAULT_ROUND_BUFFER_SEC = 2 * HOUR;

export interface RoundTiming {
  ok: boolean;
  reason?: string;
  /** Unix seconds the RezonTree round should close by (market_close − buffer). */
  roundClosesAtSec: number;
  /** Seconds from now until the market resolves. */
  secondsToMarketClose: number;
}

/** Pure: validate + compute the round window for a market closing at
 *  `closesAtSec`. Rejects markets closing within `minWindowSec` (default 18h);
 *  otherwise the round closes `bufferSec` (default 2h) before the market. */
export function computeRoundTiming(
  closesAtSec: number,
  nowSec: number,
  opts: { minWindowSec?: number; bufferSec?: number } = {},
): RoundTiming {
  const minWindow = opts.minWindowSec ?? MIN_MARKET_WINDOW_SEC;
  const buffer = opts.bufferSec ?? DEFAULT_ROUND_BUFFER_SEC;
  const secondsToMarketClose = closesAtSec - nowSec;
  const ok = secondsToMarketClose >= minWindow;
  return {
    ok,
    reason: ok
      ? undefined
      : `market resolves in ${(secondsToMarketClose / HOUR).toFixed(1)}h — need ≥ ${(minWindow / HOUR).toFixed(0)}h so the round can run + settle before resolution (pick an 18-24h market).`,
    roundClosesAtSec: closesAtSec - buffer,
    secondsToMarketClose,
  };
}

export interface PredictionQuestion {
  title: string;
  description: string;
  successCriteria: { name: string; type: string; target: string; weight: number }[];
  timing: RoundTiming;
}

const pct = (p: number): string => `${Math.round(p * 100)}%`;

/** Pure: build the RezonTree question for a market. The description elicits a
 *  numeric probability with calibrated, evidence-grounded, non-consensus
 *  reasoning; the 3 criteria reward shown work (calibration / evidence /
 *  falsifiability). `timing.ok === false` ⇒ caller should skip this market. */
export function buildPredictionQuestion(
  market: PredictionMarket,
  nowSec: number,
  opts: { minWindowSec?: number; bufferSec?: number } = {},
): PredictionQuestion {
  const timing = computeRoundTiming(market.closesAt, nowSec, opts);
  const market_view =
    market.currentProbabilities && market.currentProbabilities.length === market.outcomes.length
      ? market.outcomes.map((o, i) => `${o} ${pct(market.currentProbabilities![i])}`).join(" · ")
      : "(no current price provided)";

  const title = `What is the probability that: ${market.question}`;
  const source_line = market.url
    ? `**Source market (research against this):** ${market.url}`
    : `**Source market:** (URL not provided by the source — name the exact market you researched.)`;
  const description = [
    `## The question`,
    `Estimate the probability of the outcome of this market, resolving by the deadline:`,
    `> ${market.question}`,
    ``,
    source_line,
    ``,
    `Outcomes: ${market.outcomes.join(" / ")}. Current market view: ${market_view}.`,
    ``,
    `## What a winning answer does`,
    `Give a single NUMERIC probability in [0, 1] for the outcome, then show the work:`,
    `- **Anchor to a base rate** before you update from it — what's the unconditional rate for this kind of event? State it, then move.`,
    `- **Cite checkable evidence** (data, precedent, mechanism) — not vibes. Each load-bearing claim names a number, a date, or a source.`,
    `- **Bring a non-consensus angle.** The current market view is the price to BEAT, not to echo. If you agree with it, say precisely why the crowd is right; if you disagree, name the mispricing and the evidence the market is under-weighting.`,
    `- **Name the resolution + what would falsify you.** State exactly how this resolves and which observation, before the deadline, would prove your probability wrong.`,
    `- **Cite the source market.** Your answer MUST reference the exact market URL above (in the body and in \`references\`) — it is the research target your probability is measured against. An answer that doesn't link the market it's pricing is treated as unverified.`,
    ``,
    `Calibration beats confidence: a well-argued 0.62 out-scores an anchored 0.95. Reserve extreme probabilities for outcomes a skeptic could not move.`,
    ``,
    `Submissions are scored against the criteria below; the highest-conviction calibrated answer wins. This round closes before the market resolves, so the crowd's probability is settled in time to act on.`,
  ].join("\n");

  return {
    title,
    description,
    successCriteria: [
      { name: "calibrated_probability", type: "boolean", target: "true", weight: 45 },
      { name: "evidence_grounded", type: "boolean", target: "true", weight: 30 },
      { name: "non_consensus_and_falsifiable", type: "boolean", target: "true", weight: 25 },
    ],
    timing,
  };
}

export interface PredictionPick {
  market: PredictionMarket;
  question: PredictionQuestion;
}

/** Pure: build prediction questions for a list of markets, keeping only those
 *  whose round can close before resolution (timing.ok) and capping at `limit`.
 *  This is the `rt predict` selection step — kept out of the CLI so it tests
 *  without a live market fetch. */
export function selectPredictionQuestions(
  markets: PredictionMarket[],
  nowSec: number,
  opts: { limit?: number; minWindowSec?: number; bufferSec?: number } = {},
): PredictionPick[] {
  const picks: PredictionPick[] = [];
  for (const market of markets) {
    const question = buildPredictionQuestion(market, nowSec, opts);
    if (!question.timing.ok) continue;
    picks.push({ market, question });
    if (opts.limit && picks.length >= opts.limit) break;
  }
  return picks;
}
