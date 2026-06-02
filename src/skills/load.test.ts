import { describe, expect, it } from "vitest";

import { loadCard, loadContext } from "./load.js";

describe("loadCard", () => {
  it("loads a skill card from skills/", () => {
    const s = loadCard("cost-check");
    expect(s).toContain("Cost-awareness checklist");
  });

  it("falls back to a prompt scaffold in prompts/ by the same name", () => {
    const s = loadCard("voter_workflow");
    expect(s.length).toBeGreaterThan(0);
  });

  it("throws (never silent-empty) on an unknown card", () => {
    expect(() => loadCard("no-such-card-xyz")).toThrow(/not found in skills\/ or prompts\//);
  });
});

describe("loadContext", () => {
  it("assembles multiple cards in order, separated", () => {
    const s = loadContext(["cost-check", "error-recovery"]);
    const costAt = s.indexOf("Cost-awareness checklist");
    const errAt = s.indexOf("Recovering from structured errors");
    expect(costAt).toBeGreaterThanOrEqual(0);
    expect(errAt).toBeGreaterThan(costAt); // order preserved
    expect(s).toContain("\n\n---\n\n"); // separator between cards
  });

  it("propagates the throw if any named card is missing", () => {
    expect(() => loadContext(["cost-check", "no-such-card-xyz"])).toThrow();
  });
});
