#!/usr/bin/env tsx
// audit-balances.ts — one-shot balance sheet for the operator set.
//
// Usage:
//   npx tsx scripts/audit-balances.ts [qid] [intent_hash ...]
// e.g.
//   npx tsx scripts/audit-balances.ts \
//     0xa29c396d... 0x00aabb... 0x00ccdd...
//
// Positional args are optional. First, a qid to read poolAmount
// for. Subsequent args are intent_hashes (solution + vote) to
// read bonds for. With no args you get just wallet balances +
// total router USDC (no internal decomposition).

import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { printSnapshot, snapshot } from "../src/accounting/balances.js";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = 84532;
const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROUTER = process.env.RT_FORGE_ADDRESS as Address | undefined;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!ROUTER) throw new Error("RT_FORGE_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const positional = process.argv.slice(2);
const qid = positional[0] as Hex | undefined;
const intentHashes = positional.slice(1) as Hex[];

// Derive the four named wallets (w0 questioner+funder+oracle,
// w1 solver, w2 voter, fee_wallet).
const w0 = deriveAgentWallet(MNEMONIC, 0, CHAIN_ID);
const w1 = deriveAgentWallet(MNEMONIC, 1, CHAIN_ID);
const w2 = deriveAgentWallet(MNEMONIC, 2, CHAIN_ID);
const fee = deriveAgentWallet(MNEMONIC, 3, CHAIN_ID);

const publicClient = createPublicClient({
  transport: http(RPC),
});

const snap = await snapshot({
  publicClient,
  usdc: USDC,
  router: ROUTER!,
  wallets: [
    { name: "w0 funder/oracle", address: w0.address },
    { name: "w1 solver", address: w1.address },
    { name: "w2 voter", address: w2.address },
    { name: "fee_wallet", address: fee.address },
  ],
  qids: qid ? [qid] : [],
  solutionIntentHashes: intentHashes,
  voteIntentHashes: intentHashes,
});

printSnapshot(snap, "Operator balance sheet");
