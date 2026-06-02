import { describe, expect, it } from "vitest";

import { loadPersonaCards } from "./load.js";

describe("loadPersonaCards", () => {
  const personas = loadPersonaCards();

  it("loads exactly the four persona cards", () => {
    expect(Object.keys(personas).sort()).toEqual(["generalist", "researcher", "solver", "voter"]);
  });

  it("preserves the action weights byte-for-byte (fund-path drift fence)", () => {
    // buildActionMenu consumes these numbers; a change here shifts the swarm's
    // posting/voting distribution. Pin them so a card edit can't drift silently.
    expect(personas.researcher.weights).toEqual({ ask: 6, solve: 3, vote: 3, cosponsor: 1 });
    expect(personas.solver.weights).toEqual({ ask: 1, solve: 6, vote: 3, cosponsor: 1 });
    expect(personas.voter.weights).toEqual({ ask: 1, solve: 2, vote: 6, cosponsor: 1 });
    expect(personas.generalist.weights).toEqual({ ask: 3, solve: 4, vote: 4, cosponsor: 2 });
  });

  it("carries label + content body (no how-to on the card)", () => {
    expect(personas.solver.label).toBe("Solver");
    expect(personas.solver.blurb).toBe("Writes deep, iterated, falsifiable solutions to earn the pool.");
  });
});
