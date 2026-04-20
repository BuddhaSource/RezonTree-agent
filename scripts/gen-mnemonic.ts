#!/usr/bin/env tsx
// One-shot mnemonic generator + address lister.
// Usage: npx tsx scripts/gen-mnemonic.ts
//
// Generates a fresh BIP-39 mnemonic, derives 6 agent addresses,
// prints them with faucet links. Does NOT write to .env — the
// operator copies the mnemonic block into their own .env.

import { english, generateMnemonic } from "viem/accounts";
import { BASE_SEPOLIA } from "../src/testnet/config.js";
import { deriveAgentWallets } from "../src/wallet/derive.js";

const NAMES = [
  "questioner-01",
  "questioner-02",
  "solver-02",
  "solver-03",
  "solver-04",
  "solver-05",
];

const mnemonic = generateMnemonic(english);
const wallets = deriveAgentWallets(mnemonic, 6, BASE_SEPOLIA.chainId);

console.log("");
console.log("  ╔══════════════════════════════════════════════════════════════╗");
console.log("  ║  RezonTree agent testnet keys — Base Sepolia (chain 84532)  ║");
console.log("  ╚══════════════════════════════════════════════════════════════╝");
console.log("");
console.log("  MNEMONIC (add to RezonTree-agent/.env; DO NOT commit):");
console.log("");
console.log(`    RT_AGENT_MNEMONIC="${mnemonic}"`);
console.log("");
console.log("  Derived addresses (fund each with ≥0.005 ETH + ≥$10 USDC):");
console.log("");
for (let i = 0; i < wallets.length; i++) {
  console.log(`    [${i}] ${NAMES[i].padEnd(18)} ${wallets[i].address}`);
}
console.log("");
console.log("  Faucets:");
console.log(`    Sepolia ETH:  ${BASE_SEPOLIA.faucetHints.nativeEth}`);
console.log(`    USDC:         ${BASE_SEPOLIA.faucetHints.usdc}`);
console.log("");
console.log("  Explorer (paste address to check balance):");
console.log(`    ${BASE_SEPOLIA.explorerUrl}/address/<addr>`);
console.log("");
console.log("  Once funded, run:");
console.log("    pnpm testnet:bootstrap       # auto-registers the wallets");
console.log("    ./scripts/run-round.sh '...'  # run a full Q&A round");
console.log("");
