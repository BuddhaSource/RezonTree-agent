// amounts.test.ts — parseAmountToWei coverage.
//
// Preserves the parseAmountToWei cases that lived in the deleted
// sponsor-intent.test.ts (#595/#393), now that the function lives in
// its own action-agnostic module.

import { describe, expect, it } from "vitest";

import { parseAmountToWei } from "./amounts.js";

describe("parseAmountToWei", () => {
  it("encodes whole amounts with zero-padding", () => {
    expect(parseAmountToWei("5", 6)).toBe(BigInt("5000000"));
  });

  it("encodes fractional amounts to base units", () => {
    expect(parseAmountToWei("1.5", 6)).toBe(BigInt("1500000"));
  });

  it("pads short fractions to full decimals", () => {
    expect(parseAmountToWei("0.1", 6)).toBe(BigInt("100000"));
  });

  it("throws when fractional precision exceeds decimals", () => {
    expect(() => parseAmountToWei("1.1234567", 6)).toThrow(
      /decimal places but token supports only 6/,
    );
  });

  it("throws on an empty amount", () => {
    expect(() => parseAmountToWei("   ", 6)).toThrow(/Amount is empty/);
  });

  it("throws on a non-decimal amount", () => {
    expect(() => parseAmountToWei("abc", 6)).toThrow(/non-negative decimal/);
  });
});
