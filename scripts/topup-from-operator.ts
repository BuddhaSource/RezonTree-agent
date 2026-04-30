#!/usr/bin/env tsx
// topup-from-operator.ts — operator → alice (and optionally bob) USDC top-up.
//
// Battle conservation transfers sponsor escrow to solver across each
// scenario. With alice always sponsor + bob always solver, alice
// drains and bob accumulates. Rebalancing from operator (which holds
// fee-share residuals + the original mnemonic-default funding) is
// the failsafe when bob is too low to fund alice.
//
// F-NEW-6 hardening: skip if alice >= MIN_SPONSOR_BUFFER_USDC.
// CLI: `tsx scripts/topup-from-operator.ts [amount]`.

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

const operator = mnemonicToAccount(mnemonic, { addressIndex: 0 });
const alice = mnemonicToAccount(mnemonic, { addressIndex: 1 });

const transport = makeFallbackTransport(resolveRpcUrls(process.env));
const wallet = createWalletClient({ account: operator, chain: baseSepolia, transport });
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

const requested = parseUnits(process.argv[2] ?? "10", DECIMALS);

const aliceBal = (await publicClient.readContract({
  address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [alice.address],
})) as bigint;
const opBal = (await publicClient.readContract({
  address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [operator.address],
})) as bigint;

if (aliceBal >= MIN_SPONSOR_BUFFER_USDC) {
  console.log(`alice has ${fmt(aliceBal)} USDC (>= floor ${fmt(MIN_SPONSOR_BUFFER_USDC)}); skipping`);
  process.exit(0);
}
if (opBal < requested) {
  console.error(`operator has ${fmt(opBal)} USDC; need ${fmt(requested)}; aborting`);
  process.exit(2);
}

console.log(`transferring ${fmt(requested)} USDC operator → alice (alice ${fmt(aliceBal)} → ${fmt(aliceBal + requested)})…`);
const hash = await wallet.sendTransaction({
  account: operator, chain: baseSepolia, to: USDC,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [alice.address, requested] }),
});
console.log(`  tx ${hash}`);
const r = await publicClient.waitForTransactionReceipt({ hash });
console.log(`  status: ${r.status}`);
console.log("done");
