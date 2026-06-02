// decide.ts — the sharp voter's verdict, end to end.
//
// Composes the three Phase-6 modules into one deterministic decision:
//   1. sanitize  (injection.ts)   — strip steering directives BEFORE scoring
//   2. structural (matrix.ts)     — did the sanitized solution cover the criteria
//   3. credibility (credibility.ts) — evidence vs filler, an upward boost
//   4. injection flag (injection.ts) — bad-faith authors are near-disqualified
// then allocates the voter's conviction over the most-probable winner(s).
//
// finalScore = structural × (1 + credibilityWeight × credibility) × (1 − injection)
//
// • structural (0..100) is the floor — covering the criteria is table stakes.
// • credibility BOOSTS (never kills): an evidence-backed answer beats an equally
//   structured but qualitative one, but a purely-qualitative rigorous answer is
//   NOT zeroed (it just earns no boost). This is why credibility is a multiplier
//   on 1+, not on 0 — "0 AI-slop" is expressed through the boost differential
//   plus the credibility scorer's own multiplicative filler suppression, not by
//   nuking every answer that lacks a number.
// • injection KILLS: a detected steering attempt scales the score toward 0 by
//   its severity. The vote derives only from facts vs criteria — never from what
//   a solution says about how you should vote.
//
// Stake never enters the score (matrix uses it only for read-order + tie-break);
// a big deposit cannot buy conviction.

import { scoreSolutionCredibility } from "./credibility.js";
import { sanitizeSolution, scanSolutionInjection } from "./injection.js";
import { scoreSolutions, type VoteCriterion, type VoteSolution } from "./matrix.js";

export interface DecideOptions {
  /** points to distribute (protocol default 100). */
  totalConviction?: number;
  /** protocol min allocation per recipient (default 10 → ≤10 recipients). */
  floor?: number;
  /** cap on how many solutions to back (default 4). */
  maxRecipients?: number;
  /** back a runner-up only if its score ≥ this fraction of the leader's (default 0.5). */
  relativeThreshold?: number;
  /** magnitude of the evidence boost (default 0.5 → up to +50%). */
  credibilityWeight?: number;
}

const DEFAULTS = {
  totalConviction: 100,
  floor: 10,
  maxRecipients: 4,
  relativeThreshold: 0.5,
  credibilityWeight: 0.5,
} as const;

export interface SolutionVerdict {
  intentHash: string;
  author: string;
  stakeWei: bigint;
  /** sanitized structural matrix total, 0..100. */
  structural: number;
  /** sanitized credibility aggregate, 0..1. */
  credibility: number;
  injected: boolean;
  injectionSeverity: number;
  /** composed score; relative only. */
  finalScore: number;
}

export interface ConvictionAllocation {
  intentHash: string;
  conviction: number;
}

export interface VoteDecision {
  /** every solution, ranked by finalScore desc (stake breaks ties). */
  verdicts: SolutionVerdict[];
  /** Σ conviction === totalConviction, each ≥ floor; [] when nothing is eligible. */
  allocations: ConvictionAllocation[];
  rationale: string;
}

const byScoreThenStake = (a: SolutionVerdict, b: SolutionVerdict): number =>
  b.finalScore !== a.finalScore ? b.finalScore - a.finalScore : a.stakeWei < b.stakeWei ? 1 : a.stakeWei > b.stakeWei ? -1 : 0;

/** Largest-remainder apportionment: integers proportional to weights, summing
 *  to exactly `total`. */
function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const floored = raw.map(Math.floor);
  let remainder = total - floored.reduce((s, n) => s + n, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) floored[order[k].i] += 1;
  return floored;
}

/** Allocate `total` conviction over the ranked verdicts, honouring the per-
 *  recipient floor: back fewer solutions rather than drop anyone below floor. */
export function allocateConviction(ranked: SolutionVerdict[], opts: Required<DecideOptions>): ConvictionAllocation[] {
  const eligible = ranked.filter((v) => v.finalScore > 0 && !v.injected);
  if (eligible.length === 0) return [];
  const leader = eligible[0].finalScore;
  const within = eligible.filter((v) => v.finalScore >= leader * opts.relativeThreshold);
  // At least 1: an impossible floor (floor > total) must still back the leader
  // rather than silently cast no vote. The n=1 branch is the last resort.
  const maxByFloor = opts.floor > 0 ? Math.max(1, Math.floor(opts.totalConviction / opts.floor)) : within.length;

  for (let n = Math.min(opts.maxRecipients, maxByFloor, within.length); n >= 1; n--) {
    const cand = within.slice(0, n);
    const alloc = apportion(cand.map((c) => c.finalScore), opts.totalConviction);
    if (n === 1 || alloc.every((x) => x >= opts.floor)) {
      return cand.map((c, i) => ({ intentHash: c.intentHash, conviction: alloc[i] }));
    }
  }
  return [];
}

/** Pure: judge every solution and allocate conviction to the probable winner(s). */
export function decideVote(criteria: VoteCriterion[], solutions: VoteSolution[], options: DecideOptions = {}): VoteDecision {
  const opts: Required<DecideOptions> = { ...DEFAULTS, ...options };
  if (solutions.length === 0) return { verdicts: [], allocations: [], rationale: "No solutions to judge." };

  const clean = solutions.map(sanitizeSolution);
  const structural = scoreSolutions(criteria, clean);
  const structByHash = new Map(structural.ranked.map((s) => [s.intentHash, s.total]));

  const verdicts: SolutionVerdict[] = solutions.map((raw, i) => {
    const cleaned = clean[i];
    const structuralScore = structByHash.get(raw.intentHash) ?? 0;
    const credibility = scoreSolutionCredibility(cleaned).aggregate;
    const inj = scanSolutionInjection(raw); // scan the RAW text — detect what was there
    const injFactor = inj.detected ? 1 - inj.severity : 1;
    const finalScore = structuralScore * (1 + opts.credibilityWeight * credibility) * injFactor;
    return {
      intentHash: raw.intentHash,
      author: raw.author,
      stakeWei: raw.stakeWei,
      structural: structuralScore,
      credibility,
      injected: inj.detected,
      injectionSeverity: inj.severity,
      finalScore,
    };
  });
  verdicts.sort(byScoreThenStake);

  const allocations = allocateConviction(verdicts, opts);
  const flagged = verdicts.filter((v) => v.injected).length;
  const rationale =
    allocations.length === 0
      ? `No eligible solution${flagged ? ` (${flagged} flagged for manipulation)` : ""}; cast no conviction.`
      : `Backed ${allocations.length} of ${verdicts.length} solution(s); leader ${allocations[0].intentHash} @ ${allocations[0].conviction}` +
        (flagged ? `; ${flagged} excluded for injection.` : ".");

  return { verdicts, allocations, rationale };
}
