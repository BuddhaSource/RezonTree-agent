import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadPersonaCards } from "./load.js";

const CARD = (label: string, w: [number, number, number, number], body = "x") =>
  `---\nlabel: ${label}\nweights:\n  ask: ${w[0]}\n  solve: ${w[1]}\n  vote: ${w[2]}\n  cosponsor: ${w[3]}\n---\n${body}\n`;

describe("loadPersonaCards", () => {
  const personas = loadPersonaCards();

  it("loads exactly the four persona cards", () => {
    expect(Object.keys(personas).sort()).toEqual(["generalist", "researcher", "solver", "voter"]);
  });

  it("preserves the shipped-default action weights byte-for-byte", () => {
    // buildActionMenu consumes these numbers; this pins the SHIPPED cards so a
    // default edit can't drift the swarm's posting/voting distribution silently.
    // (A private .local override is by-design unpinned — weights only pick WHICH
    // flow runs, never a signing input, so an override can't touch the fund path.)
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

describe("loadPersonaCards — .local overlay", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("a <id>.local.md overrides the shipped <id>.md whole", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-agents-"));
    writeFileSync(join(dir, "solver.md"), CARD("Solver", [1, 6, 3, 1], "shipped"));
    writeFileSync(join(dir, "solver.local.md"), CARD("My Solver", [2, 5, 2, 1], "mine"));
    const p = loadPersonaCards(dir);
    expect(Object.keys(p)).toEqual(["solver"]); // one persona, not two
    expect(p.solver.label).toBe("My Solver");
    expect(p.solver.weights).toEqual({ ask: 2, solve: 5, vote: 2, cosponsor: 1 });
    expect(p.solver.blurb).toBe("mine");
  });

  it("a <id>.local.md with no shipped sibling ADDS a persona", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-agents-"));
    writeFileSync(join(dir, "solver.md"), CARD("Solver", [1, 6, 3, 1]));
    writeFileSync(join(dir, "skeptic.local.md"), CARD("Skeptic", [1, 1, 8, 0]));
    const p = loadPersonaCards(dir);
    expect(Object.keys(p).sort()).toEqual(["skeptic", "solver"]);
    expect(p.skeptic.weights).toEqual({ ask: 1, solve: 1, vote: 8, cosponsor: 0 });
  });

  it("fails loud and NAMES the file on a malformed card", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-agents-"));
    writeFileSync(join(dir, "broken.local.md"), "no frontmatter here");
    expect(() => loadPersonaCards(dir)).toThrow(/broken\.local\.md' is malformed/);
  });

  it("rejects out-of-range weights (negative / missing) at the source", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-agents-"));
    writeFileSync(join(dir, "bad.md"), CARD("Bad", [-1, 6, 3, 1]));
    expect(() => loadPersonaCards(dir)).toThrow(/weights\.ask must be a finite number/);
  });
});
