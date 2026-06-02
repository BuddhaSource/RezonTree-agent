// orchestration/registry.ts — the closed set of deterministic flows.
//
// The selector (swarm/policy.ts buildActionMenu) chooses WHICH flow runs by an
// agent's weights; the flow itself is shared by every agent. Adding a 5th
// action means adding a flow here — there is no other extension point for
// control flow (content extends via cards; flows extend via code review).

import { askFlow } from "./flows/ask.js";
import { cosponsorFlow } from "./flows/cosponsor.js";
import { solveFlow } from "./flows/solve.js";
import { voteFlow } from "./flows/vote.js";
import type { Flow } from "./types.js";

export { askFlow, solveFlow, voteFlow, cosponsorFlow };

/** Every flow, for discovery + the context-manifest fence. Heterogeneous
 *  targets, so typed loosely; callers dispatch the typed flow directly. */
export const ALL_FLOWS: ReadonlyArray<Flow<any>> = [askFlow, solveFlow, voteFlow, cosponsorFlow];
