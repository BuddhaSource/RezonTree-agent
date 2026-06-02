import { describe, expect, it } from "vitest";

import { ALL_FLOWS } from "./registry.js";
import { loadPrompt, type PromptKey } from "../prompts/index.js";
import type { ActionKind } from "./types.js";

const EXPECTED: ActionKind[] = ["ask", "solve", "vote", "cosponsor"];

describe("orchestration registry", () => {
  it("declares exactly the closed set of action flows", () => {
    expect(ALL_FLOWS.map((f) => f.name).sort()).toEqual([...EXPECTED].sort());
  });

  it("each flow name is unique", () => {
    const names = ALL_FLOWS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every declared context card exists on disk (no dangling read)", () => {
    // loadPrompt throws if the named card is missing — the fence that makes
    // "the flow injects exactly these" a checked claim, not a hope.
    for (const flow of ALL_FLOWS) {
      for (const ref of flow.context) {
        expect(() => loadPrompt(ref as PromptKey)).not.toThrow();
      }
    }
  });
});
