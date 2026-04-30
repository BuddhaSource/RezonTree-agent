// accounting/balances.test.ts — unit coverage for verifyDelta +
// the snapshot/print helpers, parameterized on token decimals so
// 6-dp USDC and 18-dp WETH both go through the same code path.

import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";

import {
  verifyDelta,
  type BalanceSnapshot,
  type ExpectedDelta,
} from "./balances.js";
import { fmtTokenAmount, type TokenInfo } from "../format/token.js";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x3333333333333333333333333333333333333333" as Address;
const QID = "0xaaaa" + "0".repeat(60) as Hex;

const USDC: TokenInfo = {
  address: "0xusdc",
  symbol: "USDC",
  decimals: 6,
};
const WETH: TokenInfo = {
  address: "0xweth",
  symbol: "WETH",
  decimals: 18,
};

/** Build a minimal snapshot keyed only by what verifyDelta reads. */
function snap(
  walletA: bigint,
  walletB: bigint,
  router: bigint,
  pool: bigint,
): BalanceSnapshot {
  return {
    takenAtMs: 0,
    wallets: [
      { name: "alice", address: ALICE, tokenAmount: walletA },
      { name: "bob", address: BOB, tokenAmount: walletB },
    ],
    router: {
      address: ROUTER,
      totalToken: router,
      pools: { [QID]: pool },
      solutionStakes: {},
      voteStakes: {},
    },
    totalToken: walletA + walletB + router,
  };
}

describe.each([
  { name: "USDC (6 dp)", token: USDC, unit: 1_000_000n }, // $1
  { name: "WETH (18 dp)", token: WETH, unit: 10n ** 18n }, // 1 ETH
])("verifyDelta — $name", ({ token, unit }) => {
  it("passes when wallet → router fund movement matches expectation", () => {
    const before = snap(100n * unit, 0n, 0n, 0n);
    const after = snap(50n * unit, 0n, 50n * unit, 50n * unit);

    const expected: ExpectedDelta = {
      action: "fund",
      byAddress: { [ALICE]: -50n * unit },
      routerTotal: 50n * unit,
      qid: QID,
      poolDelta: 50n * unit,
      chainTotal: 0n,
    };

    const result = verifyDelta(before, after, expected);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.actualByAddress[ALICE]).toBe(-50n * unit);
    expect(result.actualRouterTotal).toBe(50n * unit);
    expect(result.actualChainTotal).toBe(0n);
  });

  it("flags chain-total drift (token leaked)", () => {
    const before = snap(100n * unit, 0n, 0n, 0n);
    // Router only got 49 — 1 unit vanished.
    const after = snap(50n * unit, 0n, 49n * unit, 49n * unit);

    const expected: ExpectedDelta = {
      action: "fund",
      byAddress: { [ALICE]: -50n * unit },
      routerTotal: 50n * unit,
      qid: QID,
      poolDelta: 50n * unit,
      chainTotal: 0n,
    };

    const result = verifyDelta(before, after, expected);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.includes("CHAIN TOTAL DRIFTED"))).toBe(
      true,
    );
  });

  it("flags an unexpected non-zero delta on an unspecified wallet", () => {
    const before = snap(100n * unit, 0n, 0n, 0n);
    // Bob received 1 unit out of nowhere.
    const after = snap(50n * unit, 1n * unit, 49n * unit, 49n * unit);

    const expected: ExpectedDelta = {
      action: "fund",
      byAddress: { [ALICE]: -50n * unit },
      routerTotal: 49n * unit,
      qid: QID,
      poolDelta: 49n * unit,
      chainTotal: 0n,
    };

    const result = verifyDelta(before, after, expected);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.includes(BOB))).toBe(true);
  });

  it("formats 1 base unit correctly via fmtTokenAmount", () => {
    // Sanity: the printable representation should be "1.0 SYMBOL"
    // (or "$1.0 SYMBOL" for USD-named tokens) regardless of decimals.
    const out = fmtTokenAmount(unit, token);
    if (token.symbol === "USDC") {
      expect(out).toBe("$1 USDC");
    } else {
      expect(out).toBe("1 WETH");
    }
  });
});
