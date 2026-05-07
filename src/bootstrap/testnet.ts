#!/usr/bin/env tsx
// Testnet bootstrap.
//
// Orchestration: derive → print addresses → wait for operator
// funding → auto-register each agent via /auth/wallet → report.
//
// Runs as a single script invocation; idempotent. Safe to
// re-run after partial funding (the script polls until every
// agent is above threshold). Failing /auth/wallet calls for
// individual agents are reported but don't block others.
//
// Usage:
//   pnpm run testnet:bootstrap    [via npm script in package.json]
//   npx tsx src/bootstrap/testnet.ts
//
// Env (all via .env + dotenv):
//   RT_AGENT_MNEMONIC        required
//   RT_AGENT_BACKEND_URL     required for register phase
//   RT_AGENT_AGENT_COUNT     optional; default 6
//   RT_AGENT_FUND_TIMEOUT_MS optional; default 600000 (10 min)
//   RT_AGENT_FUND_POLL_MS    optional; default 10000 (10 s)
//   RT_AGENT_RPC_URL         optional; overrides public Base Sepolia
//   RT_AGENT_ERROR_*         optional; see Reporter in src/reporting
//
// Exit codes:
//   0  all agents funded + registered
//   1  timeout waiting for funding OR any register call failed
//   2  misconfiguration (missing mnemonic, bad env)

import "dotenv/config";

import {
  formatAddressList,
  formatFundingStatus,
  formatRegistrationSummary,
} from "./formatter.js";
import { fromEnv as reporterFromEnv } from "../reporting/reporter.js";
import { loadTestnetConfig } from "../testnet/config.js";
import {
  getAgentBalance,
  isFunded,
} from "../wallet/balance.js";
import { deriveAgentWallets } from "../wallet/derive.js";
import { loadLoginDomain } from "../wallet/domain.js";
import { signWalletLoginIntent } from "../wallet/signer.js";
import {
  DEFAULT_FUNDING_THRESHOLD,
  type AgentWallet,
  type BalanceSnapshot,
} from "../wallet/types.js";

// Canonical agent names. Order matches HD indices declared in
// mcp-servers.yaml: 0 = questioner-01, 1 = questioner-02,
// 2-5 = solver-02..05.
const DEFAULT_AGENT_NAMES = [
  "questioner-01",
  "questioner-02",
  "solver-02",
  "solver-03",
  "solver-04",
  "solver-05",
];

async function main(): Promise<number> {
  const reporter = reporterFromEnv();
  const cfg = loadTestnetConfig();
  const domain = loadLoginDomain();

  const mnemonic = process.env.RT_AGENT_MNEMONIC?.trim();
  if (!mnemonic) {
    await reporter.report(
      new Error(
        "RT_AGENT_MNEMONIC not set — testnet bootstrap cannot proceed",
      ),
    );
    return 2;
  }

  const backendUrl = (
    process.env.RT_AGENT_BACKEND_URL ||
    process.env.REZONTREE_API_URL ||
    "http://localhost:8080"
  ).replace(/\/$/, "");

  const agentCount = Math.max(
    1,
    Number.parseInt(process.env.RT_AGENT_AGENT_COUNT ?? "6", 10),
  );
  const agentNames = DEFAULT_AGENT_NAMES.slice(0, agentCount);
  while (agentNames.length < agentCount) {
    agentNames.push(`agent-${agentNames.length}`);
  }

  const fundTimeoutMs = Number.parseInt(
    process.env.RT_AGENT_FUND_TIMEOUT_MS ?? "600000",
    10,
  );
  const fundPollMs = Number.parseInt(
    process.env.RT_AGENT_FUND_POLL_MS ?? "10000",
    10,
  );

  // ── Phase A: derive ────────────────────────────────────
  let wallets: AgentWallet[];
  try {
    wallets = deriveAgentWallets(mnemonic, agentCount, domain.chainId);
  } catch (err) {
    await reporter.report(err);
    return 2;
  }

  process.stdout.write(formatAddressList(wallets, cfg, agentNames));

  // ── Phase B: wait for funding ──────────────────────────
  const threshold = DEFAULT_FUNDING_THRESHOLD;
  const deadline = Date.now() + fundTimeoutMs;
  let snapshots: BalanceSnapshot[] = [];
  let fundedFlags = new Array<boolean>(agentCount).fill(false);

  while (Date.now() < deadline) {
    snapshots = await Promise.all(
      wallets.map((w) => getAgentBalance(w.address)),
    );
    fundedFlags = snapshots.map((s) => isFunded(s, threshold));
    process.stdout.write(
      formatFundingStatus(wallets, snapshots, fundedFlags, agentNames) + "\n",
    );
    if (fundedFlags.every(Boolean)) break;
    await new Promise((r) => setTimeout(r, fundPollMs));
  }

  const missing = fundedFlags
    .map((f, i) => (f ? null : agentNames[i]))
    .filter((x): x is string => x !== null);
  if (missing.length > 0) {
    await reporter.report(
      new Error(
        `Funding timeout after ${fundTimeoutMs}ms. Unfunded: ${missing.join(", ")}`,
      ),
    );
    return 1;
  }

  // ── Phase C: register (sign + POST /auth/wallet) ───────
  const results: Array<{
    index: number;
    name: string;
    address: string;
    agentId: string;
    httpStatus: number;
  }> = [];
  let hadFailure = false;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const name = agentNames[i];
    try {
      const body = await signWalletLoginIntent({
        wallet: w,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        domain,
      });
      const resp = await fetch(`${backendUrl}/auth/wallet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = (await resp.json()) as {
        accessToken?: string;
        address?: string;
        error?: { code?: string; message?: string; action?: string };
      };
      if (!resp.ok || !raw.accessToken) {
        hadFailure = true;
        await reporter.report(
          raw.error ?? new Error(`/auth/wallet returned ${resp.status}`),
          { agentName: name, agentIndex: i, phase: "register" },
        );
        continue;
      }
      results.push({
        index: i,
        name,
        address: w.address,
        agentId: raw.address ?? "(unknown)",
        httpStatus: resp.status,
      });
    } catch (err) {
      hadFailure = true;
      await reporter.report(err, {
        agentName: name,
        agentIndex: i,
        phase: "register",
      });
    }
  }

  process.stdout.write(formatRegistrationSummary(results));

  await reporter.close();

  return hadFailure ? 1 : 0;
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url.startsWith("file:") && process.argv[1]) {
  const scriptPath = new URL(import.meta.url).pathname;
  if (process.argv[1].endsWith(scriptPath.split("/").pop() ?? "")) {
    main()
      .then((code) => process.exit(code))
      .catch((err) => {
        process.stderr.write(`testnet-bootstrap crashed: ${err}\n`);
        process.exit(1);
      });
  }
}
