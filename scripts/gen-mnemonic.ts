#!/usr/bin/env tsx
// One-shot mnemonic generator + address lister.
// Usage: npx tsx scripts/gen-mnemonic.ts
//
// Generates a fresh BIP-39 mnemonic, derives 6 agent addresses, prints
// them. Does NOT write to .env — the operator copies the mnemonic block
// into their own .env. Mainnet (Base, chain 8453) by default.

import { english, generateMnemonic } from "viem/accounts";
import { deriveAgentWallets } from "../src/wallet/derive.js";

// Mainnet by default; pass RT_NETWORK=testnet to derive/label for Base Sepolia.
const IS_TESTNET = process.env.RT_NETWORK === "testnet";
const CHAIN_ID = IS_TESTNET ? 84532 : 8453;
const CHAIN_LABEL = IS_TESTNET ? "Base Sepolia (chain 84532)" : "Base mainnet (chain 8453)";
const EXPLORER = IS_TESTNET ? "https://sepolia.basescan.org" : "https://basescan.org";

const NAMES = [
  "questioner-01",
  "questioner-02",
  "solver-02",
  "solver-03",
  "solver-04",
  "solver-05",
];

const mnemonic = generateMnemonic(english);
const wallets = deriveAgentWallets(mnemonic, 6, CHAIN_ID);

console.log("");
console.log("  ╔══════════════════════════════════════════════════════════════╗");
console.log(`  ║  RezonTree agent keys — ${CHAIN_LABEL.padEnd(34)}║`);
console.log("  ╚══════════════════════════════════════════════════════════════╝");
console.log("");
console.log("  MNEMONIC (add to RezonTree-agent/.env; DO NOT commit):");
console.log("");
console.log(`    RT_AGENT_MNEMONIC="${mnemonic}"`);
console.log("");
console.log("  Derived addresses (fund each with a little ETH for gas + USDC to participate):");
console.log("");
for (let i = 0; i < wallets.length; i++) {
  console.log(`    [${i}] ${NAMES[i].padEnd(18)} ${wallets[i].address}`);
}
console.log("");
console.log("  Explorer (paste address to check balance):");
console.log(`    ${EXPLORER}/address/<addr>`);
console.log("");
console.log("  Once funded, run:");
console.log("    rt wallet list        # confirm balances");
console.log("    rt doctor             # verify network + connectivity");
console.log("");
