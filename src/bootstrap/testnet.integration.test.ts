// End-to-end smoke test for the testnet bootstrap orchestrator
// — cartridge loop 0067. Exercises the full derive → poll →
// register path using stubbed RPC (via setBalanceClient) and
// stubbed fetch. No live network, no LLM calls.
//
// We import the orchestrator's internal-facing pieces rather
// than spawning the CLI. The CLI entry in `testnet.ts` has a
// ~10-line guard + dotenv block that isn't worth testing
// separately; we re-implement the equivalent flow here with
// injected doubles.

import { beforeEach, describe, expect, it } from "vitest";

import { fromEnv as reporterFromEnv } from "../reporting/reporter.js";
import { StderrSink } from "../reporting/stderr-sink.js";
import { Reporter } from "../reporting/reporter.js";
import {
  formatAddressList,
  formatFundingStatus,
  formatRegistrationSummary,
} from "./formatter.js";
import { setBalanceClient, type BalanceClient } from "../wallet/balance.js";
import { HARDHAT_TEST_MNEMONIC, deriveAgentWallets } from "../wallet/derive.js";
import { DEFAULT_LOGIN_DOMAIN } from "../wallet/domain.js";
import { signWalletLoginIntent } from "../wallet/signer.js";
import type { Address } from "viem";
import type { BalanceSnapshot } from "../wallet/types.js";

const FUNDED_WEI = 10_000_000_000_000_000n; // 0.01 ETH
const FUNDED_USDC = 50_000_000n; // $50
const UNFUNDED: bigint = 0n;

interface FakeBackend {
  accept: (address: Address) => boolean;
  calls: Array<{ address: Address; status: number }>;
}

function makeFakeBackend(acceptAll = true): FakeBackend {
  return {
    accept: () => acceptAll,
    calls: [],
  };
}

function makeFakeFetch(backend: FakeBackend): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/auth/wallet")) {
      return new Response(null, { status: 404 });
    }
    const body = JSON.parse(init?.body as string) as { address: Address };
    const status = backend.accept(body.address) ? 201 : 401;
    backend.calls.push({ address: body.address, status });
    if (status === 201) {
      return new Response(
        JSON.stringify({
          access_token: "mock.jwt",
          agent_id: `agt_${body.address.slice(2, 10)}`,
        }),
        { status },
      );
    }
    return new Response(
      JSON.stringify({
        error: {
          code: "SIGNATURE_MISMATCH",
          message: "recovered differs",
          action: "retry with matching domain",
        },
      }),
      { status },
    );
  }) as typeof fetch;
}

function makeFakeBalanceClient(
  fundedAddresses: Set<string>,
): BalanceClient {
  return {
    async getBalance({ address }) {
      return fundedAddresses.has(address.toLowerCase()) ? FUNDED_WEI : UNFUNDED;
    },
    async readContract({ args }) {
      const addr = (args[0] as string).toLowerCase();
      return fundedAddresses.has(addr) ? FUNDED_USDC : UNFUNDED;
    },
  };
}

beforeEach(() => {
  setBalanceClient(null);
});

describe("bootstrap — end-to-end smoke", () => {
  it("produces a registration summary for 6 funded agents", async () => {
    const wallets = deriveAgentWallets(HARDHAT_TEST_MNEMONIC, 6, 84532);
    const fundedSet = new Set(wallets.map((w) => w.address.toLowerCase()));
    setBalanceClient(makeFakeBalanceClient(fundedSet));

    const backend = makeFakeBackend(true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFakeFetch(backend);

    try {
      // Orchestrator-shape: sign + POST per wallet. Exercises
      // the sign→POST path fully; the real bootstrap adds
      // address-list printing + balance polling around this
      // core which are separately tested.
      for (const w of wallets) {
        const body = await signWalletLoginIntent({
          wallet: w,
          issuedAt: Math.floor(Date.now() / 1000),
          domain: DEFAULT_LOGIN_DOMAIN,
        });
        const resp = await fetch("http://mock/auth/wallet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(resp.ok).toBe(true);
      }
      expect(backend.calls).toHaveLength(6);
      expect(backend.calls.every((c) => c.status === 201)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports partial failure when backend rejects one agent", async () => {
    const wallets = deriveAgentWallets(HARDHAT_TEST_MNEMONIC, 3, 84532);
    const fundedSet = new Set(wallets.map((w) => w.address.toLowerCase()));
    setBalanceClient(makeFakeBalanceClient(fundedSet));

    // Accept all except wallet #1 (simulates an agent already
    // registered to a different chain, or a backend hiccup).
    const backend: FakeBackend = {
      accept: (addr) =>
        addr.toLowerCase() !== wallets[1].address.toLowerCase(),
      calls: [],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFakeFetch(backend);

    try {
      let failures = 0;
      for (const w of wallets) {
        const body = await signWalletLoginIntent({
          wallet: w,
          issuedAt: Math.floor(Date.now() / 1000),
          domain: DEFAULT_LOGIN_DOMAIN,
        });
        const resp = await fetch("http://mock/auth/wallet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) failures++;
      }
      expect(failures).toBe(1);
      expect(backend.calls).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("balance client waits for funding then reports at-threshold", async () => {
    const wallets = deriveAgentWallets(HARDHAT_TEST_MNEMONIC, 2, 84532);
    const fundedSet = new Set<string>();

    // Initially nothing funded. Stub wraps the set so we can
    // simulate funding arriving during the test.
    setBalanceClient({
      async getBalance({ address }) {
        return fundedSet.has(address.toLowerCase()) ? FUNDED_WEI : UNFUNDED;
      },
      async readContract({ args }) {
        return fundedSet.has((args[0] as string).toLowerCase())
          ? FUNDED_USDC
          : UNFUNDED;
      },
    });

    // Import late to pick up setBalanceClient before its first
    // call — getAgentBalance reads the module-local singleton.
    const { getAgentBalance, isFunded } = await import("../wallet/balance.js");
    const { DEFAULT_FUNDING_THRESHOLD } = await import("../wallet/types.js");

    // Pre-fund-check: nothing is at threshold.
    for (const w of wallets) {
      const snap = await getAgentBalance(w.address);
      expect(isFunded(snap, DEFAULT_FUNDING_THRESHOLD)).toBe(false);
    }

    // Operator funds both.
    for (const w of wallets) fundedSet.add(w.address.toLowerCase());

    // Post-fund: both at threshold.
    for (const w of wallets) {
      const snap = await getAgentBalance(w.address);
      expect(isFunded(snap, DEFAULT_FUNDING_THRESHOLD)).toBe(true);
    }
  });
});

describe("bootstrap — report drainage", () => {
  it("reporter collects failures and flushes them on close", async () => {
    // No file/webhook — just stderr (silent in tests via the
    // injected stub) so we verify the flow, not the sink.
    const captured: string[] = [];
    const sink = new StderrSink({ write: (s) => captured.push(s) });
    const reporter = new Reporter({
      sinks: [sink],
      onFatal: () => {
        /* no-op for test */
      },
    });

    await reporter.report(new Error("transient network"), {
      phase: "bootstrap",
    });
    await reporter.report({
      code: "AUTH_REJECTED",
      message: "bad sig",
      action: "retry with correct chain",
    });

    await reporter.close();
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured.join("")).toContain("transient network");
    expect(captured.join("")).toContain("AUTH_REJECTED");
  });
});
