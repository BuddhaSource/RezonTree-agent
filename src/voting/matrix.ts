// matrix.ts — the sharp voter's structural baseline.
//
// A voter reads solutions hard before allocating conviction. This builds the
// (criterion × solution) matrix that frames that read: it does NOT judge whether
// a claim is *true* (that's the agent's job — facts, not polish), it scores the
// OBSERVABLE structure that separates a real attempt from slop — does the
// solution actually address each criterion, with an argument and a falsifiable
// check? A high-weight criterion with no claim forfeits that weight.
//
// Two orderings, both surfaced:
//   • readOrder — highest stake first. Stake is skin in the game; read the
//     solutions that risked the most first.
//   • ranked    — structural score first (stake breaks ties). The most-probable
//     winner to scrutinize, before the agent applies judgment.
//
// Loop 20 feeds fact/slop scoring into `completeness`; Loop 21 sanitizes the
// argument text for injection before it's ever scored. The semantic verdict is
// the agent's; this just makes the gaps impossible to miss.

/** A substantive argument floor — shorter than this reads as a stub, not a case. */
export const MIN_ARGUMENT_CHARS = 40;

export interface VoteCriterion {
  id: string;
  name: string;
  /** basis-point-ish weight; the question's 3 criteria sum to 100. */
  weight: number;
}

export interface VoteClaim {
  criterionId: string;
  value?: unknown;
  argument?: string;
  falsifiableBy?: string;
}

export interface VoteSolution {
  intentHash: string;
  author: string;
  /** staked amount (skin in the game) — read-order + tie-break, NOT the score. */
  stakeWei: bigint;
  claims: VoteClaim[];
}

export interface CriterionVerdict {
  criterionId: string;
  hasClaim: boolean;
  hasArgument: boolean;
  hasFalsifiable: boolean;
  /** structural completeness 0..1 for this criterion, before its weight. */
  completeness: number;
}

export interface SolutionScore {
  intentHash: string;
  author: string;
  stakeWei: bigint;
  perCriterion: CriterionVerdict[];
  /** weighted structural score 0..100 (Σ weight × completeness). */
  total: number;
  /** criteria with no claim at all — a high-weight gap is near-disqualifying. */
  uncovered: number;
}

export interface VoteMatrix {
  /** Solutions in read order: highest stake first (skin in the game). */
  readOrder: SolutionScore[];
  /** Solutions ranked by structural score; stake breaks ties. Winner first. */
  ranked: SolutionScore[];
}

function scoreOne(criteria: VoteCriterion[], sol: VoteSolution): SolutionScore {
  let total = 0;
  let uncovered = 0;
  const perCriterion = criteria.map((c): CriterionVerdict => {
    const claim = sol.claims.find((cl) => cl.criterionId === c.id);
    const hasClaim = claim !== undefined;
    const hasArgument = (claim?.argument?.trim().length ?? 0) >= MIN_ARGUMENT_CHARS;
    const hasFalsifiable = (claim?.falsifiableBy?.trim().length ?? 0) > 0;
    // claim present = 0.4 base; a substantive argument +0.4; a falsifiable
    // check +0.2. No claim = 0 → the criterion's full weight is forfeited.
    const completeness = hasClaim ? 0.4 + (hasArgument ? 0.4 : 0) + (hasFalsifiable ? 0.2 : 0) : 0;
    if (!hasClaim) uncovered += 1;
    total += c.weight * completeness;
    return { criterionId: c.id, hasClaim, hasArgument, hasFalsifiable, completeness };
  });
  return { intentHash: sol.intentHash, author: sol.author, stakeWei: sol.stakeWei, perCriterion, total, uncovered };
}

const byStakeDesc = (a: SolutionScore, b: SolutionScore): number =>
  a.stakeWei < b.stakeWei ? 1 : a.stakeWei > b.stakeWei ? -1 : 0;

/** Pure: build the vote matrix. Scores each solution's structural completeness
 *  against the criteria, then returns it in read order (stake desc) and ranked
 *  (score desc, stake breaks ties). */
export function scoreSolutions(criteria: VoteCriterion[], solutions: VoteSolution[]): VoteMatrix {
  const scored = solutions.map((s) => scoreOne(criteria, s));
  const readOrder = [...scored].sort(byStakeDesc);
  const ranked = [...scored].sort((a, b) => (b.total !== a.total ? b.total - a.total : byStakeDesc(a, b)));
  return { readOrder, ranked };
}
