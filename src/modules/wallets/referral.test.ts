// modules/wallets/referral.test.ts — unit coverage for the pure helpers
// in referral.ts. The applyReferralCode flow itself needs a live backend
// + signing account, so it's covered by integration tests downstream;
// here we lock the format/normalization + env-var resolution invariants.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveReferralCode } from "./referral.js";

describe("resolveReferralCode", () => {
  const originalEnv = process.env.REZONTREE_REFERRAL_CODE;

  beforeEach(() => {
    delete process.env.REZONTREE_REFERRAL_CODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.REZONTREE_REFERRAL_CODE;
    } else {
      process.env.REZONTREE_REFERRAL_CODE = originalEnv;
    }
  });

  it("returns the CLI flag when supplied", () => {
    expect(resolveReferralCode("alic2")).toBe("alic2");
  });

  it("falls back to env var when CLI flag is undefined", () => {
    process.env.REZONTREE_REFERRAL_CODE = "bob92";
    expect(resolveReferralCode(undefined)).toBe("bob92");
  });

  it("CLI flag wins over env var", () => {
    process.env.REZONTREE_REFERRAL_CODE = "bob92";
    expect(resolveReferralCode("alic2")).toBe("alic2");
  });

  it("trims whitespace on both flag and env var", () => {
    expect(resolveReferralCode("  alic2  ")).toBe("alic2");

    process.env.REZONTREE_REFERRAL_CODE = "  bob92  ";
    expect(resolveReferralCode(undefined)).toBe("bob92");
  });

  it("empty string in flag falls through to env var", () => {
    process.env.REZONTREE_REFERRAL_CODE = "bob92";
    expect(resolveReferralCode("")).toBe("bob92");
  });

  it("whitespace-only flag falls through to env var", () => {
    process.env.REZONTREE_REFERRAL_CODE = "bob92";
    expect(resolveReferralCode("   ")).toBe("bob92");
  });

  it("returns undefined when neither source is set", () => {
    expect(resolveReferralCode(undefined)).toBeUndefined();
  });

  it("returns undefined when both sources are empty", () => {
    process.env.REZONTREE_REFERRAL_CODE = "  ";
    expect(resolveReferralCode("  ")).toBeUndefined();
  });

  it("does NOT normalize case (backend does that)", () => {
    // Caller passes through whatever was typed; the backend lowercases
    // on receive. This keeps the helper a pure pass-through.
    expect(resolveReferralCode("ALIC2")).toBe("ALIC2");
  });
});
