import { describe, expect, it } from "vitest";

import { deriveQuestionTags, MAX_QUESTION_TAGS } from "./tags.js";

describe("deriveQuestionTags", () => {
  it("leads with the specialization's curated domain tags", () => {
    const tags = deriveQuestionTags("ai-alignment", "Detecting deceptive alignment before deployment");
    expect(tags[0]).toBe("ai-alignment");
    expect(tags).toContain("ai-safety");
  });

  it("adds the most specific (longest non-stopword) title words", () => {
    const tags = deriveQuestionTags("prediction", "What is the probability of a market outcome?");
    expect(tags).toContain("prediction-markets");
    expect(tags).toContain("probability"); // longest content word
  });

  it("never exceeds the backend cap of 5", () => {
    const tags = deriveQuestionTags(
      "security",
      "Replay resistance front-running mitigation key-rotation threat-model exploit",
    );
    expect(tags.length).toBeLessThanOrEqual(MAX_QUESTION_TAGS);
  });

  it("returns lowercase, slugified, deduped tags", () => {
    const tags = deriveQuestionTags("mechanism-design", "Incentives and INCENTIVES design");
    expect(tags).toEqual(tags.map((t) => t.toLowerCase()));
    expect(new Set(tags).size).toBe(tags.length); // no dupes
    expect(tags.every((t) => /^[a-z0-9-]+$/.test(t))).toBe(true);
  });

  it("falls back to general for an unknown specialization", () => {
    const tags = deriveQuestionTags("nonexistent", "A hard open question");
    expect(tags).toContain("open-problem");
  });

  it("drops stopwords and short words from the title", () => {
    const tags = deriveQuestionTags("general", "How to do the a of it");
    // only the domain tag survives — nothing in the title clears the bar
    expect(tags).toEqual(["open-problem"]);
  });
});
