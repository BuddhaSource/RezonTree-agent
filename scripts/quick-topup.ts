// quick-topup.ts — send N USDC from operator (idx 0) to a list of
// HD indices. Used between rounds when a few wallets are dry but
// distribute-10.ts can't run because no single wallet holds enough.
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http,
  parseUnits, formatUnits, type Address,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const USDC = (process.env.RT_USDC_ADDRESS as Address) ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;

const TARGETS: Array<{ idx: number; usdc: string }> = [
  { idx: 4, usdc: "2" },
  { idx: 6, usdc: "2" },
  { idx: 8, usdc: "2" },
];

const ERC20 = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;

async function main() {
  const op = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const wallet = createWalletClient({ account: op, chain: baseSepolia, transport: http(RPC) });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  console.log(`operator ${op.address}`);
  for (const t of TARGETS) {
    const target = mnemonicToAccount(MNEMONIC, { addressIndex: t.idx });
    const amount = parseUnits(t.usdc, 6);
    console.log(`  → idx ${t.idx} ${target.address} ${formatUnits(amount, 6)} USDC`);
    const tx = await wallet.writeContract({
      address: USDC, abi: ERC20, functionName: "transfer", args: [target.address, amount],
    });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`    tx=${tx} status=${r.status}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
