import { describe, expect, it } from "vitest";

import {
  resolvePersona,
  resolveSpecialization,
  DEFAULT_PERSONA,
  DEFAULT_SPECIALIZATION,
} from "../personas/registry.js";
import { buildOnboardPlan, MAX_TEAM_SIZE, renderOnboardPlan } from "./onboard.js";

describe("registry resolvers", () => {
  it("resolves known ids case-insensitively", () => {
    expect(resolvePersona("Researcher").id).toBe("researcher");
    expect(resolveSpecialization("AI-Alignment").id).toBe("ai-alignment");
  });
  it("falls back to defaults on unknown", () => {
    expect(resolvePersona("nope").id).toBe(DEFAULT_PERSONA);
    expect(resolveSpecialization("nope").id).toBe(DEFAULT_SPECIALIZATION);
    expect(resolvePersona(undefined).id).toBe(DEFAULT_PERSONA);
  });
});

describe("buildOnboardPlan", () => {
  it("assigns a balanced persona roster with HD indices 1..N", () => {
    const plan = buildOnboardPlan({ specialization: "ai-alignment", teamSize: 4, blend: "balanced" });
    expect(plan.agents).toHaveLength(4);
    expect(plan.agents.map((a) => a.idx)).toEqual([1, 2, 3, 4]);
    expect(plan.agents.map((a) => a.name)).toEqual(["alice", "bob", "carol", "dave"]);
    // balanced cycle = researcher, solver, solver, voter
    expect(plan.agents.map((a) => a.persona.id)).toEqual(["researcher", "solver", "solver", "voter"]);
  });

  it("clamps team size to [1, MAX]", () => {
    expect(buildOnboardPlan({ specialization: "general", teamSize: 0, blend: "balanced" }).agents).toHaveLength(1);
    expect(buildOnboardPlan({ specialization: "general", teamSize: 99, blend: "balanced" }).agents).toHaveLength(MAX_TEAM_SIZE);
  });

  it("uses specialization topic seeds when no override given", () => {
    const plan = buildOnboardPlan({ specialization: "mechanism-design", teamSize: 2, blend: "solve" });
    expect(plan.topics).toEqual(plan.specialization.topicSeeds);
    expect(plan.topics.length).toBeGreaterThan(0);
  });

  it("honors explicit topic overrides", () => {
    const plan = buildOnboardPlan({
      specialization: "general",
      teamSize: 1,
      blend: "research",
      topics: ["my custom hard question"],
    });
    expect(plan.topics).toEqual(["my custom hard question"]);
  });

  it("falls back to balanced on an unknown blend", () => {
    const plan = buildOnboardPlan({ specialization: "general", teamSize: 4, blend: "nonsense" as never });
    expect(plan.blend).toBe("balanced");
  });

  it("emits an env snippet with the agent roster + a post-a-question nudge", () => {
    const plan = buildOnboardPlan({ specialization: "security", teamSize: 3, blend: "solve" });
    expect(plan.envSnippet).toContain("ORGANIC_AGENTS=alice,bob,carol");
    expect(plan.envSnippet).toContain("RT_SPECIALIZATION=security");
    expect(plan.nextSteps.join(" ")).toMatch(/post a question/i);
    // the quality lens (trainable-content rigor) is surfaced
    expect(renderOnboardPlan(plan)).toContain(plan.specialization.qualityLens);
  });

  it("solve blend skews the roster toward solvers", () => {
    const plan = buildOnboardPlan({ specialization: "general", teamSize: 4, blend: "solve" });
    const solvers = plan.agents.filter((a) => a.persona.id === "solver").length;
    expect(solvers).toBeGreaterThanOrEqual(3);
  });

  it("emits RT_BUDGET_USD when a budget is set, omits it otherwise", () => {
    const capped = buildOnboardPlan({ specialization: "general", teamSize: 1, blend: "balanced", budgetUsd: 10 });
    expect(capped.envSnippet).toContain("RT_BUDGET_USD=10");
    expect(capped.nextSteps.join(" ")).toMatch(/\$10 cap/);

    const uncapped = buildOnboardPlan({ specialization: "general", teamSize: 1, blend: "balanced" });
    expect(uncapped.envSnippet).not.toContain("RT_BUDGET_USD");
    expect(uncapped.nextSteps.join(" ")).toMatch(/No spend cap/);
  });

  it("treats a non-positive budget as no cap", () => {
    const plan = buildOnboardPlan({ specialization: "general", teamSize: 1, blend: "balanced", budgetUsd: 0 });
    expect(plan.envSnippet).not.toContain("RT_BUDGET_USD");
  });
});
