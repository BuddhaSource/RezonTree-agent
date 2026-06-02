// policy.ts — the swarm's pure decision core: how long to run, and which action
// to weight each tick. Extracted from organic-swarm so it's unit-testable (the
// swarm script throws on missing env at load, so it can't be imported under
// vitest). The swarm computes candidate counts (impure, from the API) and
// delegates the decision here.

import type { ActionWeights } from "../personas/registry.js";

/** Resolve the run deadline (ms). durationSec <= 0 ⇒ run forever (Infinity) —
 *  the continuous "keep the board warm" mode; else nowMs + durationSec*1000. */
export function resolveDeadlineMs(durationSec: number, nowMs: number): number {
  return durationSec <= 0 ? Number.POSITIVE_INFINITY : nowMs + durationSec * 1000;
}

export interface MenuInputs {
  /** A wallet that reverted on insufficient funds only idles (don't retry). */
  broke: boolean;
  openCount: number;
  asksSoFar: number;
  maxAsks: number;
  /** Refill the board (allow asks past the per-agent cap) when fewer than this
   *  many questions are open — so a forever-run never lets the board drain. */
  warmFloor: number;
  solvableCount: number;
  votableCount: number;
  cosponsorableCount: number;
  /** The agent's persona action-weight profile. */
  weights: ActionWeights;
}

/** Build the weighted action menu for one tick. `idle` is always available; a
 *  broke agent only idles. Below `warmFloor` every persona refills the board
 *  even past the ask cap (keep-warm + board-empty boost); above it the
 *  per-agent ask cap bounds production. Only actions with live candidates are
 *  offered. Returns `[action, weight][]` for a weighted random pick. */
export function buildActionMenu(m: MenuInputs): [string, number][] {
  const menu: [string, number][] = [["idle", 1]];
  if (m.broke) return menu;
  const warm = m.openCount < m.warmFloor;
  if (warm || m.asksSoFar < m.maxAsks) {
    menu.push(["ask", warm ? m.weights.ask + 4 : m.weights.ask]);
  }
  if (m.solvableCount > 0) menu.push(["solve", m.weights.solve]);
  if (m.votableCount > 0) menu.push(["vote", m.weights.vote]);
  if (m.cosponsorableCount > 0) menu.push(["cosponsor", m.weights.cosponsor]);
  return menu;
}

export interface DecisionExplanation {
  menu: [string, number][];
  /** the chosen action. */
  choice: string;
  /** the chosen action's weight, and the total it competed against. */
  weight: number;
  total: number;
  /** weight / total — the pick probability. */
  share: number;
  /** human/agent-readable why: what was available + what was chosen. */
  reasons: string[];
}

/** Pick an action from the weighted menu AND explain WHY — a single pure call an
 *  agent runs with zero network: it already knows the counts, so it never has to
 *  fetch to reason about what to do next. `roll` in [0,1) is injectable for
 *  determinism; omitted ⇒ Math.random(). The pick is identical to the inline
 *  weighted walk the swarm used before. */
export function explainDecision(m: MenuInputs, roll: number = Math.random()): DecisionExplanation {
  const menu = buildActionMenu(m);
  const total = menu.reduce((s, [, w]) => s + w, 0);
  let r = roll * total;
  let [choice, weight] = menu[0];
  for (const [act, w] of menu) {
    if ((r -= w) <= 0) {
      choice = act;
      weight = w;
      break;
    }
  }
  const reasons: string[] = [];
  if (m.broke) {
    reasons.push("wallet is broke (insufficient funds) — idling until refunded");
  } else {
    if (m.openCount < m.warmFloor) reasons.push(`board below warm floor (${m.openCount} < ${m.warmFloor}) — ask boosted to refill`);
    else if (m.asksSoFar >= m.maxAsks) reasons.push(`ask cap reached (${m.asksSoFar}/${m.maxAsks})`);
    if (m.solvableCount > 0) reasons.push(`${m.solvableCount} solvable`);
    if (m.votableCount > 0) reasons.push(`${m.votableCount} votable`);
    if (m.cosponsorableCount > 0) reasons.push(`${m.cosponsorableCount} cosponsorable`);
  }
  const share = total > 0 ? weight / total : 0;
  reasons.push(`→ ${choice} (${weight}/${total}, ${Math.round(share * 100)}%)`);
  return { menu, choice, weight, total, share, reasons };
}
