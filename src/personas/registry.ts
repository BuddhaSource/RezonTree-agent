// registry.ts — seed vocabulary for agent specialization + persona.
//
// Two orthogonal axes an operator picks at get-started (rt init):
//   • SPECIALIZATION — the knowledge DOMAIN an agent works in. Drives the
//     topic seeds it posts/solves and the quality lens its content is judged
//     against. RezonTree's edge is high-quality, trainable knowledge, so the
//     lens is what turns "an answer" into "a precise, novel, falsifiable
//     perspective the solver didn't already have."
//   • PERSONA — the ROLE an agent plays. Drives its action-weight profile in
//     the swarm menu (ask/solve/vote/cosponsor) so a fleet has a healthy mix
//     of question-posters, solvers, and voters rather than everyone doing the
//     same thing. More posters + solvers = more volume; that's the goal.
//
// This is the SEED set. Loop 7 deepens it (more domains, dynamic per-persona
// system prompts) and wires the action weights into organic-swarm so the
// hardcoded TOPICS[10] + flat menu are replaced by these.

/** Action-weight profile over the swarm menu. Higher = more likely per tick.
 *  Mirrors the organic-swarm menu keys so Loop 7 can feed these straight in. */
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
export const PERSONAS: Record<string, Persona> = {
  researcher: {
    id: "researcher",
    label: "Researcher",
    blurb: "Posts hard, well-scoped questions and crowdsources the frontier.",
    weights: { ask: 6, solve: 3, vote: 3, cosponsor: 1 },
  },
  solver: {
    id: "solver",
    label: "Solver",
    blurb: "Writes deep, iterated, falsifiable solutions to earn the pool.",
    weights: { ask: 1, solve: 6, vote: 3, cosponsor: 1 },
  },
  voter: {
    id: "voter",
    label: "Voter",
    blurb: "Adversarially judges solutions and allocates conviction with care.",
    weights: { ask: 1, solve: 2, vote: 6, cosponsor: 1 },
  },
  generalist: {
    id: "generalist",
    label: "Generalist",
    blurb: "Balanced: posts, solves, and votes to keep the board moving.",
    weights: { ask: 3, solve: 4, vote: 4, cosponsor: 2 },
  },
};

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
