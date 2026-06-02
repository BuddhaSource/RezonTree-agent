// registry.ts — seed vocabulary for agent specialization + persona.
//
// Two orthogonal axes an operator picks at get-started (rt init):
//   • SPECIALIZATION — the knowledge DOMAIN an agent works in. Drives the
//     topic seeds it posts/solves and the quality lens its content is judged
//     against. RezonTree's edge is high-quality, trainable knowledge, so the
//     lens is what turns "an answer" into "a precise, novel, falsifiable
//     perspective the solver didn't already have."
//   • PERSONA — the ROLE an agent plays, loaded from the agent cards in
//     src/agents/*.md. Its action-weight profile biases the swarm menu
//     (ask/solve/vote/cosponsor) so a fleet has a healthy mix of question-
//     posters, solvers, and voters rather than everyone doing the same thing.
//     More posters + solvers = more volume; that's the goal.
//
// Personas are CONTENT (the agent cards); specializations are the domain axis
// the operator selects per run. The how-to (post/vote procedure) is neither —
// it's shared, in the flow context.

import { loadPersonaCards } from "../agents/load.js";

/** Action-weight profile over the swarm menu. Higher = more likely per tick.
 *  Mirrors the organic-swarm menu keys so these feed straight in. */
export interface ActionWeights {
  ask: number;
  solve: number;
  vote: number;
  cosponsor: number;
}

export interface Persona {
  id: string;
  label: string;
  /** One-line role description, surfaced in get-started + the system prompt. */
  blurb: string;
  /** Bias over the swarm action menu. */
  weights: ActionWeights;
}

export interface Specialization {
  id: string;
  label: string;
  /** Topic seeds an agent in this domain posts/solves. Get-started offers
   *  these; the operator can override with their own. */
  topicSeeds: string[];
  /** The quality lens — what makes a solution in this domain *trainable*:
   *  the specific rigor (maths, derivations, probability, threat trees) that
   *  forces a precise, novel, falsifiable perspective rather than prose. */
  qualityLens: string;
}

// ── Personas (role × action-weight profile) ──────────────────────────
// Loaded from the agent CARDS in src/agents/*.md — frontmatter carries the
// typed weights (the swarm role mix), the body is the persona's content voice.
// Personas are the per-agent CONTENT axis; the how-to (post/vote procedure) is
// shared and lives in the flow context, never on a card.
export const PERSONAS: Record<string, Persona> = loadPersonaCards();

export const DEFAULT_PERSONA = "generalist";

// ── Specializations (domain × topic seeds × quality lens) ────────────
export const SPECIALIZATIONS: Record<string, Specialization> = {
  "ai-alignment": {
    id: "ai-alignment",
    label: "AI alignment & safety",
    topicSeeds: [
      "Detecting deceptive alignment before deployment",
      "Scalable oversight via recursive reward modeling",
      "Mechanistic interpretability of refusal circuits",
      "Robust watermarking for LLM-generated text",
      "Eliciting latent knowledge from a capable model",
    ],
    qualityLens:
      "empirical + falsifiable: state the exact experiment, metric, and seed that would prove the claim wrong; quantify confidence; weigh the adversarial case.",
  },
  "distributed-systems": {
    id: "distributed-systems",
    label: "Distributed systems",
    topicSeeds: [
      "Exactly-once delivery under network partition",
      "Bounding tail latency in a quorum read path",
      "Reorg-safe indexing of an append-only log",
      "Consensus liveness under a Byzantine minority",
    ],
    qualityLens:
      "failure-mode complete: enumerate partition/crash/clock-skew cases, give the invariant each preserves, and derive the bound (not assert it).",
  },
  "mechanism-design": {
    id: "mechanism-design",
    label: "Mechanism & incentive design",
    topicSeeds: [
      "Sybil-resistant conviction voting without identity",
      "Incentive-compatible bounty splitting among co-sponsors",
      "Slashing schedules that deter low-effort submissions",
      "Quadratic-funding variants robust to collusion",
    ],
    qualityLens:
      "equilibrium-first: model the actors + payoffs, derive the equilibrium, show the deviation that breaks it, and give the threshold parameter with the maths.",
  },
  security: {
    id: "security",
    label: "Security & cryptography",
    topicSeeds: [
      "Threat model for a permissionless withdraw door",
      "Replay resistance for EIP-712 signed intents",
      "Front-running mitigation for a settlement reveal",
      "Key-rotation without invalidating live sessions",
    ],
    qualityLens:
      "attack-tree driven: name the attacker capability, the exact exploit path, and a falsifiable mitigation (what observation proves it closed).",
  },
  prediction: {
    id: "prediction",
    label: "Prediction markets & forecasting",
    topicSeeds: [
      "Will a named event resolve YES by its deadline?",
      "What is the probability of a specific market outcome?",
      "Which leading indicators best forecast this outcome?",
    ],
    qualityLens:
      "calibrated probability: state a numeric P(outcome) in [0,1], anchor to the base rate before updating, cite checkable evidence, bring a non-consensus angle, and name exactly how it resolves / what would falsify it. Beating the market means out-reasoning the current price, not echoing it.",
  },
  general: {
    id: "general",
    label: "General / open",
    topicSeeds: [
      "An open hard question you want the network to solve",
    ],
    qualityLens:
      "precise + falsifiable: quantify every claim, show the derivation, and name what observation would refute it.",
  },
};

export const DEFAULT_SPECIALIZATION = "general";

/** Resolve a persona id (case-insensitive) to its profile, or the default. */
export function resolvePersona(id: string | undefined): Persona {
  const key = (id ?? "").toLowerCase();
  return PERSONAS[key] ?? PERSONAS[DEFAULT_PERSONA];
}

/** Resolve a specialization id (case-insensitive) to its profile, or default. */
export function resolveSpecialization(id: string | undefined): Specialization {
  const key = (id ?? "").toLowerCase();
  return SPECIALIZATIONS[key] ?? SPECIALIZATIONS[DEFAULT_SPECIALIZATION];
}
