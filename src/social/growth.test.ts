import { describe, expect, it } from "vitest";

import {
  composeForecastBrag,
  composeInvite,
  referralCta,
  resolveReferral,
  streakLine,
  withReferral,
} from "./growth.js";
import type { SharePost } from "./index.js";

describe("referral", () => {
  it("resolves from env; CTA is empty when nothing is configured", () => {
    expect(referralCta(resolveReferral({}))).toBe("");
    expect(referralCta({ url: undefined, code: undefined })).toBe("");
  });

  it("appends ?ref=<code> to the link when both are set", () => {
    const cta = referralCta({ url: "https://rezontree.com/join", code: "alice" });
    expect(cta).toContain("https://rezontree.com/join?ref=alice");
    // honors an existing query string
    expect(referralCta({ url: "https://rezontree.com/?x=1", code: "bob" })).toContain("?x=1&ref=bob");
  });

  it("withReferral appends the CTA to a post (no-op when unconfigured)", () => {
    const post: SharePost = { action: "solve", text: "base" };
    expect(withReferral(post, { url: "https://r.tree", code: "z" }).text).toMatch(/base\nEarn on @ReZonTree/);
    expect(withReferral(post, {})).toBe(post); // unchanged
  });
});

describe("composeInvite (agent recruits agent)", () => {
  it("is agent-native + carries the referral link", () => {
    const msg = composeInvite({ fromAgent: "alice", domain: "AI alignment", ref: { url: "https://r.tree", code: "alice" } });
    expect(msg).toMatch(/I'm alice/);
    expect(msg).toMatch(/AI alignment/);
    expect(msg).toContain("https://r.tree?ref=alice");
  });
});

describe("composeForecastBrag", () => {
  it("frames the edge over the market (viral reach)", () => {
    const brag = composeForecastBrag({ questionTitle: "Rain in Dubai?", myP: 0.42, marketP: 0.55, why: "base rate held.", url: "https://r.tree/q/1" });
    expect(brag).toMatch(/Out-reasoned the market/);
    expect(brag).toMatch(/P=0\.42 vs market 0\.55/);
    expect(brag).toMatch(/-13pt edge/); // 0.42-0.55 = -13pts
    expect(brag).toContain("https://r.tree/q/1");
  });
});

describe("streakLine", () => {
  it("renders day + rank when present, nothing when absent", () => {
    expect(streakLine({ days: 7, rank: 3 })).toBe("Day 7 on @ReZonTree · #3 this week");
    expect(streakLine({ days: 1 })).toBe("Day 1 on @ReZonTree");
    expect(streakLine({})).toBe("");
  });
});
