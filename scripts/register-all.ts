#!/usr/bin/env tsx
// One-shot agent registration — skips the funding wait.
// Registers all agents from mnemonic against /auth/wallet.
import "dotenv/config";
import { deriveAgentWallets } from "../src/wallet/derive.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { loadTestnetConfig } from "../src/testnet/config.js";

const AGENT_NAMES = [
  "questioner-01","questioner-02","solver-02",
  "solver-03","solver-04","solver-05",
];

const cfg = loadTestnetConfig();
const mnemonic = process.env.RT_AGENT_MNEMONIC?.trim();
if (!mnemonic) { console.error("RT_AGENT_MNEMONIC missing"); process.exit(2); }
const backendUrl = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";
const domain = await loadLoginDomain(cfg);
const count = Number(process.env.RT_AGENT_AGENT_COUNT ?? "6");
const wallets = deriveAgentWallets(mnemonic, count, domain.chainId);

console.log(`Registering ${wallets.length} agents against ${backendUrl}...`);
let ok = 0;
for (let i = 0; i < wallets.length; i++) {
  const w = wallets[i];
  const name = AGENT_NAMES[i] ?? `agent-${i}`;
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
    const raw = (await resp.json()) as { access_token?: string; agent_id?: string; error?: unknown };
    if (!resp.ok || !raw.access_token) {
      console.error(`  [${i}] ${name} FAILED HTTP ${resp.status}:`, JSON.stringify(raw.error));
    } else {
      console.log(`  [${i}] ${name} ✓  ${w.address}  agent_id=${raw.agent_id}`);
      ok++;
    }
  } catch (e) {
    console.error(`  [${i}] ${name} ERROR:`, e);
  }
}
console.log(`\nRegistered ${ok}/${wallets.length} agents.`);
process.exit(ok === wallets.length ? 0 : 1);
