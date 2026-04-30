#!/usr/bin/env tsx
// topup-from-bob.ts — bob → alice USDC rebalancing.
//
// Battle conservation moves sponsor escrow → solver winnings each
// scenario. Bob accumulates; alice drains. This script recycles
// bob's accumulated pool back to alice so the battle can keep
// going. Total USDC across the wallet pool stays constant; only
// the role-allocation rebalances.
//
// F-NEW-6 hardening: skip the transfer if alice already has more
// than MIN_SPONSOR_BUFFER_USDC, and refuse to drain bob below
// SOURCE_MIN_USDC. CLI: `tsx scripts/topup-from-bob.ts [amount]`.

import { mnemonicToAccount } from "viem/accounts";
import {
  type Address,
  createWalletClient,
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  parseUnits,
} from "viem";
import { baseSepolia } from "viem/chains";

import {
  makeFallbackTransport,
  resolveRpcUrls,
} from "../src/testnet/rpc-fallback.js";

const mnemonic = process.env.RT_AGENT_MNEMONIC;
if (!mnemonic) throw new Error("RT_AGENT_MNEMONIC required");

const USDC = ((process.env.RT_USDC_ADDRESS as Address | undefined) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address;
const DECIMALS = 6;

const MIN_SPONSOR_BUFFER_USDC = parseUnits(
  process.env.MIN_SPONSOR_BUFFER_USDC ?? "10",
  DECIMALS,
);
const SOURCE_MIN_USDC = parseUnits(
  process.env.SOURCE_MIN_USDC ?? "30",
  DECIMALS,
);

const bob = mnemonicToAccount(mnemonic, { addressIndex: 2 });
const alice = mnemonicToAccount(mnemonic, { addressIndex: 1 });

const transport = makeFallbackTransport(resolveRpcUrls(process.env));
const wallet = createWalletClient({ account: bob, chain: baseSepolia, transport });
const publicClient = createPublicClient({ chain: baseSepolia, transport });

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
] as const;

const fmt = (b: bigint) => formatUnits(b, DECIMALS);

const requested = parseUnits(process.argv[2] ?? "30", DECIMALS);

const aliceBal = (await publicClient.readContract({
  address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [alice.address],
})) as bigint;
const bobBal = (await publicClient.readContract({
  address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [bob.address],
})) as bigint;

if (aliceBal >= MIN_SPONSOR_BUFFER_USDC) {
  console.log(`alice has ${fmt(aliceBal)} USDC (>= floor ${fmt(MIN_SPONSOR_BUFFER_USDC)}); skipping`);
  process.exit(0);
}
if (bobBal < requested + SOURCE_MIN_USDC) {
  console.error(
    `bob has ${fmt(bobBal)} USDC; need ${fmt(requested)} + source-min ${fmt(SOURCE_MIN_USDC)}; aborting`,
  );
  process.exit(2);
}

console.log(`transferring ${fmt(requested)} USDC bob → alice (alice ${fmt(aliceBal)} → ${fmt(aliceBal + requested)})…`);
const hash = await wallet.sendTransaction({
  account: bob, chain: baseSepolia, to: USDC,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [alice.address, requested] }),
});
console.log(`  tx ${hash}`);
const r = await publicClient.waitForTransactionReceipt({ hash });
console.log(`  status: ${r.status}`);
