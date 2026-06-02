import { describe, expect, it } from "vitest";

import { simulateAgentJourney, type JourneyScenario } from "./index.js";

const scenario = (over: Partial<JourneyScenario> = {}): JourneyScenario => ({
  menu: {
    broke: false,
    openCount: 10,
    asksSoFar: 0,
    maxAsks: 3,
    warmFloor: 3,
    solvableCount: 4,
    votableCount: 2,
    cosponsorableCount: 1,
    weights: { ask: 3, solve: 6, vote: 3, cosponsor: 1 },
  },
  roll: 0.5,
  question: { id: "qst_1", title: "Will it rain in Dubai before 2027?" },
  ...over,
});

describe("simulateAgentJourney — agent ergonomics fence", () => {
  it("reaches first action in ONE network read (discovery local, decision pure)", () => {
    const j = simulateAgentJourney(scenario());
    expect(j.readsToFirstAction).toBe(1); // just the candidate-question list
  });

  it("share + recruit add ZERO network reads (pure growth)", () => {
    const j = simulateAgentJourney(scenario());
    expect(j.totalNetworkReads).toBe(1); // unchanged by share/recruit
    for (const s of j.steps) {
      if (s.step !== "discover") expect(s.networkReads).toBe(0);
    }
  });

  it("one catalog read surfaces every action (O(1) discovery, not O(N))", () => {
    const j = simulateAgentJourney(scenario());
    expect(j.actionsKnownFromOneRead).toBeGreaterThanOrEqual(4);
  });

  it("the chosen action is a known flow, and it produces a demonstrating share", () => {
    // a solve-leaning persona with candidates present picks a real action
    const j = simulateAgentJourney(scenario({ roll: 0.6 }));
    expect(["ask", "solve", "vote", "cosponsor", "idle"]).toContain(j.chosenAction);
    if (j.chosenAction !== "idle") {
      expect(j.sharePreview).toContain("@ReZonTree");
      expect(j.sharePreview).toContain("rezontree.com/questions/qst_1"); // link-back funnel
    }
  });

  it("the recruit step always yields an agent-native invite", () => {
    const j = simulateAgentJourney(scenario({ referral: { url: "https://rezontree.com/join", code: "sim" } }));
    expect(j.invitePreview).toMatch(/I'm sim/);
    expect(j.invitePreview).toContain("https://rezontree.com/join?ref=sim");
  });

  it("walks all five steps in order", () => {
    const j = simulateAgentJourney(scenario({ roll: 0.6 }));
    expect(j.steps.map((s) => s.step)).toEqual(["discover", "decide", "act-plan", "share", "recruit"]);
  });
});
