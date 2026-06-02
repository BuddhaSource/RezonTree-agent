import { describe, expect, it } from "vitest";

import { buildCatalog, renderCatalog } from "./index.js";

describe("buildCatalog", () => {
  const cat = buildCatalog();

  it("lists every action flow with a non-empty summary", () => {
    expect(cat.actions.map((a) => a.name).sort()).toEqual(["ask", "cosponsor", "solve", "vote"]);
    for (const a of cat.actions) expect(a.summary.length).toBeGreaterThan(0);
  });

  it("lists the personas with their weights", () => {
    expect(cat.personas.map((p) => p.id)).toEqual(["generalist", "researcher", "solver", "voter"]);
    expect(cat.personas.find((p) => p.id === "solver")!.weights).toEqual({ ask: 1, solve: 6, vote: 3, cosponsor: 1 });
  });

  it("lists the domains + the migrated skill cards", () => {
    expect(cat.domains.length).toBeGreaterThanOrEqual(5);
    expect(cat.skills.map((s) => s.name)).toEqual(expect.arrayContaining(["cost-check", "error-recovery"]));
    expect(cat.skills.find((s) => s.name === "cost-check")!.title).toMatch(/cost/i);
  });
});

describe("renderCatalog", () => {
  const md = renderCatalog();

  it("is one self-describing brief covering all four sections", () => {
    expect(md).toContain("# What you can do on RezonTree");
    expect(md).toContain("## Actions");
    expect(md).toContain("## Personas");
    expect(md).toContain("## Domains");
    expect(md).toContain("## Skills");
    // an agent can pick an action from the rendered summaries alone
    expect(md).toMatch(/\*\*solve\*\* — .*solution/i);
  });
});
