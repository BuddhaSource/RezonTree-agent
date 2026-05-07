// Formatter coverage. Pure string builders; no RPC, no fs, no backend.

import { describe, expect, it } from "vitest";

import { BASE_SEPOLIA } from "../testnet/config.js";
import type { AgentWallet, BalanceSnapshot } from "../wallet/types.js";
import {
  formatAddressList,
  formatFundingStatus,
  formatRegistrationSummary,
} from "./formatter.js";

function mockWallet(index: number, address: `0x${string}`): AgentWallet {
  return {
    agentIndex: index,
    address,
    privateKey: `0x${"00".repeat(32)}`,
    chainId: 84532,
  };
}

const WALLETS: AgentWallet[] = [
  mockWallet(0, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
  mockWallet(1, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
];

const NAMES = ["questioner-01", "questioner-02"];

describe("formatAddressList", () => {
  it("includes every wallet address + agent name", () => {
    const out = formatAddressList(WALLETS, BASE_SEPOLIA, NAMES);
    for (const w of WALLETS) expect(out).toContain(w.address);
    for (const n of NAMES) expect(out).toContain(n);
  });

  it("includes faucet hints for ETH + USDC", () => {
    const out = formatAddressList(WALLETS, BASE_SEPOLIA, NAMES);
    expect(out).toContain(BASE_SEPOLIA.faucetHints.nativeEth);
    expect(out).toContain(BASE_SEPOLIA.faucetHints.usdc);
  });

  it("includes explorer URLs per wallet", () => {
    const out = formatAddressList(WALLETS, BASE_SEPOLIA, NAMES);
    for (const w of WALLETS) {
      expect(out).toContain(`${BASE_SEPOLIA.explorerUrl}/address/${w.address}`);
    }
  });

  it("cites the chain name + id so operators don't mis-fund mainnet", () => {
    const out = formatAddressList(WALLETS, BASE_SEPOLIA, NAMES);
    expect(out).toContain("base-sepolia");
    expect(out).toContain("chain 84532");
  });
});

describe("formatFundingStatus", () => {
  const snap = (
    address: `0x${string}`,
    nativeWei: bigint,
    usdcMinor: bigint,
  ): BalanceSnapshot => ({
    address,
    chainId: 84532,
    nativeWei,
    usdcMinor,
    at: 1_700_000_000,
  });

  it("reports funded/total counts", () => {
    const snaps: BalanceSnapshot[] = [
      snap(WALLETS[0].address, 10_000_000_000_000_000n, 20_000_000n),
      snap(WALLETS[1].address, 0n, 0n),
    ];
    const out = formatFundingStatus(WALLETS, snaps, [true, false], NAMES);
    expect(out).toContain("1/2 agents at threshold");
  });

  it("marks funded agents with a checkmark", () => {
    const snaps: BalanceSnapshot[] = [
      snap(WALLETS[0].address, 10_000_000_000_000_000n, 20_000_000n),
      snap(WALLETS[1].address, 0n, 0n),
    ];
    const out = formatFundingStatus(WALLETS, snaps, [true, false], NAMES);
    // Line for agent 0 should have the checkmark; agent 1 should not.
    const lineQ01 = out.split("\n").find((l) => l.includes("questioner-01"));
    const lineQ02 = out.split("\n").find((l) => l.includes("questioner-02"));
    expect(lineQ01).toContain("✓");
    expect(lineQ02).not.toContain("✓");
  });

  it("formats ETH as 5-decimal + USDC as 2-decimal", () => {
    // 12345 gwei = 0.000012345 ETH → 0.00001 (5-decimal truncates)
    // 1_234_567 USDC minor = 1.234567 → 1.23 (2-decimal)
    const snaps: BalanceSnapshot[] = [
      snap(WALLETS[0].address, 12_345_000_000_000n, 1_234_567n),
      snap(WALLETS[1].address, 0n, 0n),
    ];
    const out = formatFundingStatus(WALLETS, snaps, [false, false], NAMES);
    expect(out).toContain("0.00001 ETH");
    expect(out).toContain("1.23 USDC");
  });
});

describe("formatRegistrationSummary", () => {
  it("shows agent_id per registered agent", () => {
    const entries = [
      {
        index: 0,
        name: "questioner-01",
        address: WALLETS[0].address,
        agentId: "agt_01j9kx…",
        httpStatus: 200,
      },
      {
        index: 1,
        name: "questioner-02",
        address: WALLETS[1].address,
        agentId: "agt_01j9l0…",
        httpStatus: 200,
      },
    ];
    const out = formatRegistrationSummary(entries);
    expect(out).toContain("2 agents");
    expect(out).toContain("agt_01j9kx…");
    expect(out).toContain("agt_01j9l0…");
  });

  it("shows (201) for freshly auto-registered agents", () => {
    const entries = [
      {
        index: 0,
        name: "questioner-01",
        address: WALLETS[0].address,
        agentId: "agt_01…",
        httpStatus: 201,
      },
    ];
    const out = formatRegistrationSummary(entries);
    expect(out).toMatch(/agt_01… \(201\)/);
  });
});
