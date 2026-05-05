#!/usr/bin/env tsx
/**
 * Rebalances USDC across agent wallets.
 * Sends `amountUSDC` from `fromIndex` to `toIndex` on Base Sepolia.
 *
 * Usage:
 *   tsx scripts/rebalance-usdc.ts <fromIndex> <toIndex> <amountUSDC>
 *
 * Example — send 2 USDC from solver-06 (idx=6) to solver-07 (idx=7):
 *   tsx scripts/rebalance-usdc.ts 6 7 2
 */
import { createWalletClient, createPublicClient, http, parseUnits, encodeFunctionData } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { mnemonicToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config();

const MNEMONIC = process.env["RT_AGENT_MNEMONIC"];
if (!MNEMONIC) { console.error("RT_AGENT_MNEMONIC not set"); process.exit(1); }

const USDC = (process.env["RT_USDC_ADDRESS"] ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;
const RPC = process.env["RT_RPC_URL"] ?? "https://sepolia.base.org";

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error("Usage: tsx scripts/rebalance-usdc.ts <fromIndex> <toIndex> <amountUSDC>");
  process.exit(1);
}
const fromIdx = parseInt(args[0]!);
const toIdx   = parseInt(args[1]!);
const amount  = parseFloat(args[2]!);

function derivePrivKey(idx: number): `0x${string}` {
  const acct = mnemonicToAccount(MNEMONIC!, { path: `m/44'/60'/0'/0/${idx}` });
  const pk = acct.getHdKey().privateKey!;
  return `0x${Buffer.from(pk).toString("hex")}` as `0x${string}`;
}

const fromPK   = derivePrivKey(fromIdx);
const fromAcct = privateKeyToAccount(fromPK);
const toAcct   = mnemonicToAccount(MNEMONIC!, { path: `m/44'/60'/0'/0/${toIdx}` });

const amountRaw = parseUnits(amount.toString(), 6); // USDC = 6 decimals

const public_ = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wallet  = createWalletClient({ account: fromAcct, chain: baseSepolia, transport: http(RPC) });

const transferData = encodeFunctionData({
  abi: [{ name: "transfer", type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" }],
  functionName: "transfer",
  args: [toAcct.address, amountRaw],
});

console.log(`Transferring ${amount} USDC`);
console.log(`  From idx=${fromIdx} (${fromAcct.address})`);
console.log(`  To   idx=${toIdx}   (${toAcct.address})`);
console.log(`  Amount: ${amountRaw} raw units`);

const hash = await wallet.sendTransaction({
  to: USDC,
  data: transferData,
});
console.log(`  Tx: ${hash}`);

const receipt = await public_.waitForTransactionReceipt({ hash });
console.log(`  Status: ${receipt.status} (block ${receipt.blockNumber})`);
