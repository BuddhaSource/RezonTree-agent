// solution-body.test.ts — SA-009 floor coverage.

import { describe, expect, it } from "vitest";
import {
  MIN_SOLUTION_BODY_CHARS,
  deterministicEvidenceFooter,
  makeSolutionBody,
} from "./solution-body.js";

describe("makeSolutionBody", () => {
  it("clears 1100-char floor for a 1-char scenarioId", () => {
    const body = makeSolutionBody("alice", "a");
    expect(body.length).toBeGreaterThanOrEqual(MIN_SOLUTION_BODY_CHARS);
  });

  it("clears 1100-char floor for a long scenarioId", () => {
    const body = makeSolutionBody(
      "alice",
      "scenario_with_very_long_descriptive_id_for_test",
    );
    expect(body.length).toBeGreaterThanOrEqual(MIN_SOLUTION_BODY_CHARS);
  });

  it("is deterministic for identical inputs (content-hash stability)", () => {
    expect(makeSolutionBody("alice", "demo")).toBe(
      makeSolutionBody("alice", "demo"),
    );
  });

  it("changes when scenarioId changes (no accidental aliasing)", () => {
    expect(makeSolutionBody("alice", "demo-1")).not.toBe(
      makeSolutionBody("alice", "demo-2"),
    );
  });

  it("changes when solver changes (no accidental aliasing)", () => {
    expect(makeSolutionBody("alice", "demo")).not.toBe(
      makeSolutionBody("bob", "demo"),
    );
  });
});

describe("deterministicEvidenceFooter", () => {
  it("is deterministic for the same scenarioId", () => {
    expect(deterministicEvidenceFooter("x")).toBe(
      deterministicEvidenceFooter("x"),
    );
  });
});
