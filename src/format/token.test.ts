// format/token.test.ts — multi-currency display + parse helpers.

import { describe, it, expect } from "vitest";
import { fmtTokenAmount, parseTokenAmount, type TokenInfo } from "./token.js";

const USDC: Pick<TokenInfo, "decimals" | "symbol"> = {
  decimals: 6,
  symbol: "USDC",
};
const ETH: Pick<TokenInfo, "decimals" | "symbol"> = {
  decimals: 18,
  symbol: "ETH",
};

describe("fmtTokenAmount", () => {
  it("formats 6-decimal USDC with USD prefix", () => {
    expect(fmtTokenAmount(100_000n, USDC)).toBe("$0.1 USDC");
  });

  it("formats 18-decimal ETH without USD prefix", () => {
    expect(fmtTokenAmount(100_000_000_000_000_000n, ETH)).toBe("0.1 ETH");
  });

  it("formats whole units with no fractional digits", () => {
    expect(fmtTokenAmount(50_000_000n, USDC)).toBe("$50 USDC");
    expect(fmtTokenAmount(10n ** 18n, ETH)).toBe("1 ETH");
  });

  it("strips trailing zeros from the fractional part", () => {
    expect(fmtTokenAmount(1_500_000n, USDC)).toBe("$1.5 USDC");
  });

  it("clamps precision (default min(decimals, 6)) for 18-dp tokens", () => {
    // 1.123456789012345678 ETH → display ".123456" by default.
    expect(fmtTokenAmount(1_123_456_789_012_345_678n, ETH)).toBe(
      "1.123456 ETH",
    );
  });

  it("honors explicit precision override", () => {
    expect(
      fmtTokenAmount(1_123_456_789_012_345_678n, ETH, { precision: 2 }),
    ).toBe("1.12 ETH");
  });

  it("respects showSymbol=false", () => {
    expect(fmtTokenAmount(100_000n, USDC, { showSymbol: false })).toBe("$0.1");
  });

  it("respects usdPrefix=false on a USD-named token", () => {
    expect(fmtTokenAmount(100_000n, USDC, { usdPrefix: false })).toBe(
      "0.1 USDC",
    );
  });

  it("forces usdPrefix=true on a non-USD token if asked", () => {
    // Whole 1 ETH at 18 dp prints as "1 ETH"; with usdPrefix it
    // becomes "$1 ETH". (Tiny non-whole values would clamp to "$0"
    // at default precision, which is also fine — the assertion is
    // about prefix behavior, not precision.)
    expect(fmtTokenAmount(10n ** 18n, ETH, { usdPrefix: true })).toBe(
      "$1 ETH",
    );
  });

  it("renders negative amounts with a leading minus", () => {
    expect(fmtTokenAmount(-100_000n, USDC)).toBe("-$0.1 USDC");
  });

  it("accepts a decimal string for wei", () => {
    expect(fmtTokenAmount("100000", USDC)).toBe("$0.1 USDC");
  });

  it("returns em-dash on undefined inputs", () => {
    expect(fmtTokenAmount(undefined, USDC)).toBe("—");
    expect(fmtTokenAmount(100_000n, undefined)).toBe("—");
  });
});

describe("parseTokenAmount", () => {
  it("parses '$100' at 6 decimals → 100_000_000n", () => {
    expect(parseTokenAmount("$100", 6)).toBe(100_000_000n);
  });

  it("parses '0.5' at 18 decimals → 5e17", () => {
    expect(parseTokenAmount("0.5", 18)).toBe(500_000_000_000_000_000n);
  });

  it("parses '$1.50 USDC' tolerantly", () => {
    expect(parseTokenAmount("$1.50 USDC", 6)).toBe(1_500_000n);
  });

  it("truncates fractional digits beyond `decimals`", () => {
    // 0.1234567 USDC → 0.123456 USDC at 6 dp (no rounding).
    expect(parseTokenAmount("0.1234567", 6)).toBe(123_456n);
  });

  it("returns 0n for empty / non-numeric input", () => {
    expect(parseTokenAmount("", 6)).toBe(0n);
    expect(parseTokenAmount("abc", 6)).toBe(0n);
  });

  it("round-trips through fmtTokenAmount for a USDC value", () => {
    const fmt = fmtTokenAmount(12_345_678n, USDC);
    // "$12.345678 USDC"
    expect(parseTokenAmount(fmt, 6)).toBe(12_345_678n);
  });
});
