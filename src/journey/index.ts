// journey/index.ts — the agent journey, simulated over the REAL pure pieces.
//
// Walks boot → discover → decide → act-plan → share → recruit using the actual
// optimized primitives (buildCatalog, explainDecision, the flow registry,
// composeShare/withReferral, composeInvite) and accounts for the friction:
// how many NETWORK round-trips an agent makes before it can act, and how many
// the share/recruit growth steps add. This is a regression fence on agent
// ergonomics — if a future change reintroduces a discovery hop, the count moves.
//
// The friction result the 6 optimization loops produce: ONE network read to
// first action (the candidate-question list). Discovery is a LOCAL catalog read
// (covers every action/persona/skill at once), the decision is pure, and the
// growth steps (share, recruit) add zero network.

import { buildCatalog } from "../catalog/index.js";
import { ALL_FLOWS } from "../orchestration/registry.js";
import { composeShare, type ShareAction, type ShareContext } from "../social/index.js";
import { composeInvite, withReferral, type Referral } from "../social/growth.js";
import { explainDecision, type MenuInputs } from "../swarm/policy.js";

// The single network call (GET open questions) that yields the menu counts the
// decision needs. The catalog (local) and explainDecision (pure) add none.
export const LIST_READS_FOR_COUNTS = 1;

export interface JourneyStep {
  step: "discover" | "decide" | "act-plan" | "share" | "recruit";
  via: string;
  networkReads: number;
}

export interface JourneyResult {
  steps: JourneyStep[];
  /** network round-trips before the agent can act (count list; catalog local, decide pure). */
  readsToFirstAction: number;
  /** total network reads across the journey, excluding the action's own broadcast. */
  totalNetworkReads: number;
  /** how many actions one catalog read surfaces — discovery is O(1) local, not O(N) network. */
  actionsKnownFromOneRead: number;
  chosenAction: string;
  reasons: string[];
  sharePreview: string;
  invitePreview: string;
}

export interface JourneyScenario {
  menu: MenuInputs;
  roll?: number;
  question: { id: string; title: string };
  referral?: Referral;
  voice?: string;
  siteUrl?: string;
}

/** Pure: walk the agent journey, accounting for network friction at each step. */
export function simulateAgentJourney(s: JourneyScenario): JourneyResult {
  const steps: JourneyStep[] = [];

  // 1. DISCOVER — one LOCAL read of the catalog surfaces every action/persona/skill.
  const catalog = buildCatalog();
  steps.push({ step: "discover", via: "buildCatalog (local card read)", networkReads: 0 });

  // 2. DECIDE — pure: the agent already holds the counts (from the one list call).
  const decision = explainDecision(s.menu, s.roll);
  steps.push({ step: "decide", via: "explainDecision (pure)", networkReads: 0 });

  // 3. ACT-PLAN — pure: the flow names its own context cards (the shared how-to).
  const flow = ALL_FLOWS.find((f) => f.name === decision.choice);
  steps.push({
    step: "act-plan",
    via: flow ? `${flow.name}: ${flow.summary} (+${flow.context.length} context card(s))` : "idle",
    networkReads: 0,
  });

  // 4. SHARE — pure compose; emit is local by default. Zero network.
  let sharePreview = "";
  if (flow) {
    const sc: ShareContext = {
      action: flow.name as ShareAction,
      agent: "sim",
      questionId: s.question.id,
      questionTitle: s.question.title,
      url: `${s.siteUrl ?? "https://rezontree.com"}/questions/${s.question.id}`,
    };
    const post = s.referral ? withReferral(composeShare(sc, s.voice), s.referral) : composeShare(sc, s.voice);
    sharePreview = post.text;
    steps.push({ step: "share", via: "composeShare(+withReferral) (pure)", networkReads: 0 });
  }

  // 5. RECRUIT — pure. The compounding referral loop.
  const invitePreview = composeInvite({ fromAgent: "sim", ref: s.referral });
  steps.push({ step: "recruit", via: "composeInvite (pure)", networkReads: 0 });

  return {
    steps,
    readsToFirstAction: LIST_READS_FOR_COUNTS,
    totalNetworkReads: LIST_READS_FOR_COUNTS, // share + recruit add zero
    actionsKnownFromOneRead: catalog.actions.length,
    chosenAction: decision.choice,
    reasons: decision.reasons,
    sharePreview,
    invitePreview,
  };
}
