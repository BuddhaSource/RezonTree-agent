// modules/wallets/referral.test.ts — unit coverage for the pure helpers
// in referral.ts. The applyReferralCode flow itself needs a live backend
// + signing account, so it's covered by integration tests downstream;
// here we lock the format/normalization + env-var resolution invariants.

import type { Account } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyReferralCode,
  claimMyReferralCode,
  resolveReferralCode,
  upgradeMyReferralCode,
} from "./referral.js";

// Stub account that never actually signs. Affiliate-side validation
// short-circuits before authenticateWallet runs, so this only needs
// the address shape — signTypedData is intentionally absent so any
// accidental network attempt would throw with a clear error.
const stubAccount = {
  address: "0x0000000000000000000000000000000000000001",
} as unknown as Account;

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

// ── Format-validation short-circuit for affiliate-side helpers ────
//
// applyReferralCode / claimMyReferralCode / upgradeMyReferralCode all
// validate the code format BEFORE invoking authenticateWallet. A
// malformed code returns immediately with REFERRAL_CODE_INVALID_FORMAT
// — no signing, no network call. These tests pin that contract so a
// future refactor can't accidentally move the format check past the
// signing step (where it would burn a JWT round-trip on input we
// could have rejected locally).

describe("applyReferralCode — invalid format short-circuits", () => {
  it("rejects 4-char code without signing", async () => {
    const result = await applyReferralCode({
      account: stubAccount,
      code: "abcd",
      backendUrl: "http://unreachable.test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });

  it("rejects 6-char code without signing", async () => {
    const result = await applyReferralCode({
      account: stubAccount,
      code: "abcdef",
      backendUrl: "http://unreachable.test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });

  it("rejects punctuation without signing", async () => {
    const result = await applyReferralCode({
      account: stubAccount,
      code: "ab-cd",
      backendUrl: "http://unreachable.test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });

  it("accepts mixed-case input by normalizing (would proceed to signing — we don't assert beyond format)", async () => {
    // Mixed-case 5-char is valid after lowercase normalization. We
    // can't assert the success path without a live backend, but we
    // CAN assert it does NOT return INVALID_FORMAT (which means it
    // got past the regex). It will fail at the signing step (stub
    // account has no signTypedData) — that's a different failure code.
    const result = await applyReferralCode({
      account: stubAccount,
      code: "ALIC2",
      backendUrl: "http://unreachable.test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).not.toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });
});

describe("claimMyReferralCode — invalid desiredCode short-circuits", () => {
  it("rejects 4-char desired code without signing", async () => {
    const result = await claimMyReferralCode({
      account: stubAccount,
      backendUrl: "http://unreachable.test",
      desiredCode: "abcd",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });

  it("rejects punctuation in desired code without signing", async () => {
    const result = await claimMyReferralCode({
      account: stubAccount,
      backendUrl: "http://unreachable.test",
      desiredCode: "ab cd",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });

  it("accepts undefined desiredCode (auto-generate path)", async () => {
    // No desiredCode → no format check → proceeds straight to
    // authenticateWallet → fails at signing (stub account). Verifies
    // the omit-desired-code path doesn't trip the regex.
    const result = await claimMyReferralCode({
      account: stubAccount,
      backendUrl: "http://unreachable.test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).not.toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });
});

describe("upgradeMyReferralCode — invalid desiredCode short-circuits", () => {
  it("rejects 6-char desired code without signing", async () => {
    const result = await upgradeMyReferralCode({
      account: stubAccount,
      backendUrl: "http://unreachable.test",
      desiredCode: "abcdef",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });

  it("rejects empty desired code without signing", async () => {
    const result = await upgradeMyReferralCode({
      account: stubAccount,
      backendUrl: "http://unreachable.test",
      desiredCode: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REFERRAL_CODE_INVALID_FORMAT");
    }
  });
});
