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
