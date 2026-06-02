import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadPersonaCards } from "../agents/load.js";
import { scaffold } from "./scaffold.js";

describe("scaffold — path safety", () => {
  it("always targets a *.local.md under the right content dir", () => {
    expect(scaffold("agent", "skeptic").path).toBe("src/agents/skeptic.local.md");
    expect(scaffold("skill", "my-note").path).toBe("src/skills/my-note.local.md");
    expect(scaffold("voice").path).toBe("src/social/share-voice.local.md");
  });

  it("refuses names that could escape the content dir or hit a shipped card", () => {
    expect(() => scaffold("agent", "../solver")).toThrow(/slug name/);
    expect(() => scaffold("agent", "solver/evil")).toThrow(/slug name/);
    expect(() => scaffold("skill", "")).toThrow(/slug name/);
    expect(() => scaffold("agent", "Solver")).toThrow(/slug name/); // not lowercase
  });

  it("agent template carries valid frontmatter weights; skill carries a use-when", () => {
    expect(scaffold("agent", "skeptic").content).toMatch(/weights:\n {2}ask: 2/);
    expect(scaffold("skill", "x").content).toMatch(/Use when:/);
    expect(scaffold("voice").content).toMatch(/@ReZonTree/);
  });
});

describe("scaffold — a customization is loadable (extend without forking)", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("a scaffolded agent .local card is picked up by loadPersonaCards", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-scaffold-"));
    const s = scaffold("agent", "skeptic");
    // write under the temp dir using just the filename (path is src/agents/<slug>.local.md)
    writeFileSync(join(dir, "skeptic.local.md"), s.content);
    const personas = loadPersonaCards(dir);
    expect(personas.skeptic).toBeDefined();
    expect(personas.skeptic.weights).toEqual({ ask: 2, solve: 4, vote: 3, cosponsor: 1 });
    expect(personas.skeptic.label).toBe("Skeptic");
  });
});
