import { describe, expect, it } from "vitest";

import { ALL_FLOWS } from "./registry.js";
import { loadContext } from "../skills/load.js";
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

  it("every declared context card resolves through the unified loader (no dangling read)", () => {
    // loadContext throws if any named card is missing from skills/ or prompts/
    // — the fence that makes "the flow reads exactly these" a checked claim.
    for (const flow of ALL_FLOWS) {
      if (flow.context.length === 0) continue;
      expect(() => loadContext(flow.context)).not.toThrow();
    }
  });
});
