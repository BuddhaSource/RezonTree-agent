#!/usr/bin/env tsx
// Preflight health check.
//
// Fast, read-only sanity check the operator runs BEFORE a full
// `pnpm run-round`. Verifies the end-to-end pipe without
// running any agents or spending any tokens:
//
//   1. RT_AGENT_MNEMONIC is set + derivable → address list
//   2. RT_AGENT_BACKEND_URL reachable + /healthz returns 200
//   3. Agent 0 can sign a WalletLoginIntent + POST /auth/wallet
//      → backend accepts + returns a JWT
//
// Exit codes:
//   0 — all checks pass; safe to run pnpm run-round
//   1 — one or more checks failed (details in stderr)
//   2 — misconfiguration (RT_AGENT_MNEMONIC missing, etc.)
//
// Does NOT check:
//   - Balance (use `pnpm testnet:bootstrap` for funding)
//   - Other 5 agents (agent 0's signature proving recovery
//     works covers the same crypto path for all agents; testing
//     each one doesn't add signal)
//   - Full round execution (that's `pnpm run-round`)

import "dotenv/config";

import { fromEnv as reporterFromEnv } from "../reporting/reporter.js";
import { deriveAgentWallet, deriveAgentWallets } from "../wallet/derive.js";
import { loadLoginDomain } from "../wallet/domain.js";
import { signWalletLoginIntent } from "../wallet/signer.js";

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function checkMnemonic(): Promise<CheckResult> {
  const m = process.env.RT_AGENT_MNEMONIC?.trim();
  if (!m) {
    return {
      name: "RT_AGENT_MNEMONIC set",
      passed: false,
      detail:
        "env var missing. Add a BIP-39 mnemonic to .env (or run `pnpm testnet:bootstrap`).",
    };
  }
  try {
    const domain = loadLoginDomain();
    const wallet = deriveAgentWallet(m, 0, domain.chainId);
    return {
      name: "mnemonic derives",
      passed: true,
      detail: `agent[0] = ${wallet.address}`,
    };
  } catch (err) {
    return {
      name: "mnemonic derives",
      passed: false,
      detail: `derivation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkAddressList(): Promise<CheckResult> {
  const m = process.env.RT_AGENT_MNEMONIC?.trim();
  if (!m) {
    return {
      name: "6 agent addresses",
      passed: false,
      detail: "skipped — no mnemonic",
    };
  }
  try {
    const domain = loadLoginDomain();
    const wallets = deriveAgentWallets(m, 6, domain.chainId);
    const uniq = new Set(wallets.map((w) => w.address.toLowerCase()));
    if (uniq.size !== 6) {
      return {
        name: "6 agent addresses",
        passed: false,
        detail: `expected 6 distinct addresses, got ${uniq.size}`,
      };
    }
    return {
      name: "6 agent addresses",
      passed: true,
      detail: `${wallets.length} distinct; agent[0]=${wallets[0].address}`,
    };
  } catch (err) {
    return {
      name: "6 agent addresses",
      passed: false,
      detail: `derivation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkBackendReachable(url: string): Promise<CheckResult> {
  try {
    const resp = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) {
      return {
        name: "backend /healthz",
        passed: false,
        detail: `unexpected status ${resp.status}`,
      };
    }
    return {
      name: "backend /healthz",
      passed: true,
      detail: `${url} → ${resp.status}`,
    };
  } catch (err) {
    return {
      name: "backend /healthz",
      passed: false,
      detail: `unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkWalletLogin(url: string): Promise<CheckResult> {
  const m = process.env.RT_AGENT_MNEMONIC?.trim();
  if (!m) {
    return {
      name: "wallet /auth/wallet",
      passed: false,
      detail: "skipped — no mnemonic",
    };
  }
  try {
    const domain = loadLoginDomain();
    const wallet = deriveAgentWallet(m, 0, domain.chainId);
    const body = await signWalletLoginIntent({
      wallet,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      domain,
    });
    const resp = await fetch(`${url}/auth/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const raw = (await resp.json()) as {
      accessToken?: string;
      address?: string;
      error?: { code?: string; message?: string; action?: string };
    };
    if (!resp.ok || !raw.accessToken) {
      return {
        name: "wallet /auth/wallet",
        passed: false,
        detail: `backend rejected: ${resp.status} ${raw.error?.code ?? ""} — ${raw.error?.message ?? "(no body)"}. Action: ${raw.error?.action ?? "(none)"}`,
      };
    }
    return {
      name: "wallet /auth/wallet",
      passed: true,
      detail: `account=${raw.address ?? "(unknown)"}`,
    };
  } catch (err) {
    return {
      name: "wallet /auth/wallet",
      passed: false,
      detail: `sign/POST failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runPreflight(): Promise<{
  code: number;
  results: CheckResult[];
}> {
  const url = (
    process.env.RT_AGENT_BACKEND_URL ||
    process.env.REZONTREE_API_URL ||
    "http://localhost:8080"
  ).replace(/\/$/, "");

  const results: CheckResult[] = [];
  results.push(await checkMnemonic());
  results.push(await checkAddressList());
  results.push(await checkBackendReachable(url));
  results.push(await checkWalletLogin(url));

  const allPassed = results.every((r) => r.passed);
  const mnemonicMissing = !process.env.RT_AGENT_MNEMONIC?.trim();
  // Misconfig (exit 2) if mnemonic is simply not set — that's
  // not a "something's broken" state, it's a "nothing started"
  // state. Any other failure is exit 1.
  const code = allPassed ? 0 : mnemonicMissing ? 2 : 1;
  return { code, results };
}

export function formatPreflightReport(results: CheckResult[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  Preflight check:");
  lines.push("");
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    lines.push(`    ${mark} ${r.name.padEnd(24)} ${r.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

// CLI entry — runs only when the file is executed directly.
if (import.meta.url.startsWith("file:") && process.argv[1]) {
  const scriptPath = new URL(import.meta.url).pathname;
  if (process.argv[1].endsWith(scriptPath.split("/").pop() ?? "")) {
    const reporter = reporterFromEnv();
    runPreflight()
      .then(async ({ code, results }) => {
        process.stdout.write(formatPreflightReport(results));
        const failed = results.filter((r) => !r.passed);
        for (const f of failed) {
          await reporter.report(
            new Error(`${f.name} failed: ${f.detail}`),
            { phase: "preflight", check: f.name },
          );
        }
        await reporter.close();
        process.exit(code);
      })
      .catch((err) => {
        process.stderr.write(`preflight crashed: ${err}\n`);
        process.exit(1);
      });
  }
}
