import { describe, expect, it } from "vitest";

import { resolveDeadlineMs, buildActionMenu, type MenuInputs } from "./policy.js";

const W = { ask: 3, solve: 4, vote: 5, cosponsor: 2 };
const base = (over: Partial<MenuInputs> = {}): MenuInputs => ({
  broke: false,
  openCount: 10,
  asksSoFar: 0,
  maxAsks: 3,
  warmFloor: 3,
  solvableCount: 0,
  votableCount: 0,
  cosponsorableCount: 0,
  weights: W,
  ...over,
});
const weightOf = (menu: [string, number][], act: string) => menu.find(([a]) => a === act)?.[1];

describe("resolveDeadlineMs", () => {
  it("runs forever for 0 / negative (continuous mode)", () => {
    expect(resolveDeadlineMs(0, 1000)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveDeadlineMs(-5, 1000)).toBe(Number.POSITIVE_INFINITY);
  });
  it("computes nowMs + durationSec*1000 for a finite run", () => {
    expect(resolveDeadlineMs(1800, 1000)).toBe(1000 + 1_800_000);
  });
});

describe("buildActionMenu", () => {
  it("a broke agent only idles", () => {
    const menu = buildActionMenu(base({ broke: true, solvableCount: 5, votableCount: 5 }));
    expect(menu).toEqual([["idle", 1]]);
  });

  it("offers only actions with live candidates, weighted by persona", () => {
    const menu = buildActionMenu(base({ solvableCount: 2, votableCount: 1, cosponsorableCount: 0 }));
    expect(weightOf(menu, "solve")).toBe(W.solve);
    expect(weightOf(menu, "vote")).toBe(W.vote);
    expect(weightOf(menu, "cosponsor")).toBeUndefined(); // no candidates
  });

  it("respects the ask cap when the board is healthy", () => {
    const atCap = buildActionMenu(base({ openCount: 10, asksSoFar: 3, maxAsks: 3 }));
    expect(weightOf(atCap, "ask")).toBeUndefined(); // past cap, board healthy → no ask
    const underCap = buildActionMenu(base({ openCount: 10, asksSoFar: 1, maxAsks: 3 }));
    expect(weightOf(underCap, "ask")).toBe(W.ask); // under cap, board healthy → base weight
  });

  it("keeps the board warm: refills past the cap when open < warmFloor (boosted)", () => {
    const thinPastCap = buildActionMenu(base({ openCount: 1, warmFloor: 3, asksSoFar: 9, maxAsks: 3 }));
    expect(weightOf(thinPastCap, "ask")).toBe(W.ask + 4); // past cap but board thin → still asks, boosted
  });

  it("always includes idle", () => {
    expect(weightOf(buildActionMenu(base()), "idle")).toBe(1);
  });
});
