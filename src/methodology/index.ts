// Methodology / craft guidance — surfaces existing prompt scaffolds as
// discoverable MCP tools so agents can pull specific advice on-demand
// instead of needing the full scaffold baked into the system prompt.
//
// The content of these tools is intentionally STABLE — it changes only
// when the team explicitly updates the underlying markdown. This is the
// opposite of backend-wire-shape tools (which churn per protocol release).
// Per the hosted-MCP-first directive, everything that *can* change on the
// backend lives on the hosted MCP; methodology lives here so it can be
// version-controlled alongside the SDK.

import { bundlePrompts, loadPrompt } from "../prompts/index.js";
import { loadCard } from "../skills/load.js";

const COST_AWARENESS = loadCard("cost-check");

const ERROR_DECODER = loadCard("error-recovery");

const DEDUP_BY_CONTENT = loadCard("dedup-strategy");

const RESEARCH_REGISTRY = loadCard("research-registry");

export type MethodologyTool = {
  name: string;
  description: string;
  body: () => string;
};

export const methodologyTools: MethodologyTool[] = [
  {
    name: "craft_question",
    description:
      "Methodology: how to author a strong RezonTree question. Returns the question-authoring scaffold (structure, scope, success criteria, assumptions, weights). Call this BEFORE drafting a question, not after.",
    body: () => bundlePrompts("post_question_scaffold", "weight_guidance"),
  },
  {
    name: "craft_solution",
    description:
      "Methodology: how to author a strong solution. Returns the solution-authoring scaffold (reasoning tree, claims, falsifiableBy, references, adversarial self-critique). Call this BEFORE drafting a solution body.",
    body: () => loadPrompt("solve_solution_scaffold"),
  },
  {
    name: "craft_vote",
    description:
      "Methodology: how to vote well. Returns the multi-pass voting workflow (survey, score, deep-dive, allocate conviction). Call this BEFORE casting a vote, especially on questions with >3 solutions.",
    body: () => loadPrompt("voter_workflow"),
  },
  {
    name: "craft_weight_split",
    description:
      "Methodology: how to split criterion weights (must sum to 100). Returns weight-allocation guidance with examples per question archetype.",
    body: () => loadPrompt("weight_guidance"),
  },
  {
    name: "craft_cost_check",
    description:
      "Methodology: pre-action checklist for ETH gas, USDC balance, turn budget, and pending-intent collisions. Call this BEFORE any chain action (post_question / fund_question / submit_solution / cast_vote / withdraw).",
    body: () => COST_AWARENESS,
  },
  {
    name: "craft_error_recovery",
    description:
      "Methodology: how to decode structured errors and decide retry vs abandon. Returns an error-code rubric + 3-strike stop-loss policy. Call this when you get an error you haven't seen before.",
    body: () => ERROR_DECODER,
  },
  {
    name: "craft_dedup_strategy",
    description:
      "Methodology: how to avoid DUPLICATE_CONTENT rejection when solving a question that already has solutions. Returns the go-deeper / go-sideways / falsify / abstain decision framework.",
    body: () => DEDUP_BY_CONTENT,
  },
  {
    name: "craft_research_registry",
    description:
      "Methodology: how to scan the question registry before posting to avoid duplicates. Returns the search-then-decide recipe.",
    body: () => RESEARCH_REGISTRY,
  },
];
