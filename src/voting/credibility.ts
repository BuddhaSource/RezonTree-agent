// credibility.ts — the slop filter. 0 AI-slop tolerance, encoded.
//
// Loop 19's matrix scored *structure* (did the solution show up for each
// criterion). This scores *texture*: does the argument carry verifiable
// anchors — numbers, citations, relational/derivation operators — or is it
// confident prose padded with the canonical filler that marks machine slop?
//
// This is NOT a truth oracle. A claim can cite a fabricated number and score
// well here; verifying that number is the agent's job (the semantic layer that
// sits on top, same boundary the matrix drew). What this surfaces is the
// *prior*: an argument with zero quantitative anchors and heavy filler is slop
// until proven otherwise, and the protocol's "real work beats fluent prose"
// stance means it earns near-zero conviction regardless of how it reads.
//
// Slop suppresses multiplicatively, not additively: credibility = evidence ×
// (1 − slop). Filler can't be offset by sprinkling in a number, and prose with
// no evidence scores 0 no matter how clean it reads.
//
// KNOWN LIMITATION (by design): this is a lexical PRIOR, not a gate. Numbers are
// counted by density, not by load-bearing-ness, so content-free prose stuffed
// with figures can score high; the agent's Pass-3 fact-verification is the
// actual filter (see voter_workflow.md). decideVote treats credibility as a
// BOOST (1 + w·credibility), never a kill, precisely so this prior's blind
// spots can't zero a solution on their own.

import type { VoteClaim, VoteSolution } from "./matrix.js";

/** ≥ this many distinct numeric anchors earns full quantitative credit. */
export const EVIDENCE_NUMBER_TARGET = 3;
/** slop markers per 100 words at which an argument reads as fully slop. */
export const SLOP_RATIO_CEILING = 3;

// High-precision filler: multi-word phrases (or distinctive single tokens) that
// are almost always padding, never load-bearing. Ambiguous finance words
// ("leverage", "synergy") are deliberately excluded — too many false positives
// on a DeFi/prediction platform.
export const SLOP_PHRASES: readonly string[] = [
  "as an ai",
  "as a large language model",
  "it is important to note",
  "it's important to note",
  "it is worth noting",
  "it's worth noting",
  "in conclusion",
  "in summary",
  "to summarize",
  "delve into",
  "rich tapestry",
  "navigate the complexities",
  "plays a crucial role",
  "plays a vital role",
  "plays a pivotal role",
  "a testament to",
  "in today's world",
  "in the realm of",
  "first and foremost",
  "needless to say",
  "at the end of the day",
  "i hope this helps",
  "ever-evolving",
  "multifaceted",
];

// Anchors a skeptic could go check. Numbers are counted by density; the rest
// are present/absent.
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;
const CITATION_RES: readonly RegExp[] = [
  /https?:\/\/\S+/i, // url
  /\b10\.\d{4,}\/\S+/, // doi
  /\bet al\.?/i, // academic citation
  /\[\d+\]/, // bracketed reference
  /\(\d{4}\)/, // (year) reference
];
// Relational/derivation operators AND explicit reasoning connectives. The
// connectives matter: a rigorous QUALITATIVE argument (a proof, a mechanism-
// design case, a threat model) carries no numbers but is real evidence — the
// reasoning markers let it clear the floor instead of being scored as slop for
// lacking a digit. "0 AI-slop" must not mean "0 prose".
const OPERATOR_RE =
  /[<>=≤≥≈±∴∎]|\b(?:per|vs\.?|versus|therefore|hence|thus|because|implies?|contradiction|counterexample|lemma|theorem|QED)\b/i;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export type CredibilityVerdict = "evidence-backed" | "mixed" | "slop";

export interface CredibilitySignals {
  /** distinct numeric tokens — quantitative density. */
  numberCount: number;
  /** any url / doi / "et al" / [n] / (year). */
  hasCitation: boolean;
  /** any relational or comparative operator (<, =, per, vs). */
  hasOperator: boolean;
  /** total filler-phrase occurrences. */
  slopMarkers: number;
  /** filler occurrences per 100 words. */
  slopRatio: number;
  wordCount: number;
}

export interface CredibilityScore {
  signals: CredibilitySignals;
  /** 0..1 how evidence-backed the text is. */
  evidence: number;
  /** 0..1 how much filler dilutes it. */
  slop: number;
  /** 0..1 net = evidence × (1 − slop). The multiplier on structural weight. */
  credibility: number;
  verdict: CredibilityVerdict;
}

/** Pure: score one block of argument text for evidence vs slop. */
export function scoreCredibility(text: string): CredibilityScore {
  const raw = text ?? "";
  const lower = raw.toLowerCase();
  const words = raw.trim().length === 0 ? [] : raw.trim().split(/\s+/);
  const wordCount = words.length;

  const numberCount = (raw.match(NUMBER_RE) ?? []).length;
  const hasCitation = CITATION_RES.some((re) => re.test(raw));
  const hasOperator = OPERATOR_RE.test(raw);

  let slopMarkers = 0;
  for (const phrase of SLOP_PHRASES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(phrase, from);
      if (at === -1) break;
      slopMarkers += 1;
      from = at + phrase.length;
    }
  }
  const slopRatio = wordCount === 0 ? 0 : slopMarkers / (wordCount / 100);

  const evidence = clamp01(
    0.5 * Math.min(1, numberCount / EVIDENCE_NUMBER_TARGET) +
      0.3 * (hasCitation ? 1 : 0) +
      0.2 * (hasOperator ? 1 : 0),
  );
  const slop = clamp01(slopRatio / SLOP_RATIO_CEILING);
  const credibility = clamp01(evidence * (1 - slop));

  const verdict: CredibilityVerdict =
    credibility >= 0.6 ? "evidence-backed" : slop >= 0.5 || evidence < 0.2 ? "slop" : "mixed";

  return { signals: { numberCount, hasCitation, hasOperator, slopMarkers, slopRatio, wordCount }, evidence, slop, credibility, verdict };
}

/** Score one claim's argument text (empty argument → 0 across the board). */
export function scoreClaimCredibility(claim: VoteClaim): CredibilityScore {
  return scoreCredibility(claim.argument ?? "");
}

export interface SolutionCredibility {
  intentHash: string;
  perCriterion: Array<{ criterionId: string; credibility: CredibilityScore }>;
  /** mean credibility across claims that actually carry an argument (0 if none). */
  aggregate: number;
  verdict: CredibilityVerdict;
}

/** Pure: score every claim in a solution, plus a body-level aggregate.
 *  Claims with no argument don't dilute the mean — they're a *structural* gap
 *  the matrix already penalizes; here we judge only what was actually written. */
export function scoreSolutionCredibility(sol: VoteSolution): SolutionCredibility {
  const perCriterion = sol.claims.map((c) => ({ criterionId: c.criterionId, credibility: scoreClaimCredibility(c) }));
  const argued = perCriterion.filter((p) => p.credibility.signals.wordCount > 0);
  const aggregate = argued.length === 0 ? 0 : argued.reduce((s, p) => s + p.credibility.credibility, 0) / argued.length;
  const verdict: CredibilityVerdict =
    aggregate >= 0.6 ? "evidence-backed" : aggregate < 0.2 ? "slop" : "mixed";
  return { intentHash: sol.intentHash, perCriterion, aggregate, verdict };
}
