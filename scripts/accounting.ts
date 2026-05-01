#!/usr/bin/env tsx
import "dotenv/config";
import { createPublicClient, http, formatUnits, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FORGE =
  (process.env.RT_FORGE_ADDRESS as Address) ??
  "0x6c70fb6f59e1f2c3b9456a30c3856be0032300d1";
const M = process.env.RT_AGENT_MNEMONIC!;
const client = createPublicClient({ transport: http(RPC) });
const ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "o", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function main() {
  let total = 0n;
  for (let i = 0; i <= 13; i++) {
    const a = mnemonicToAccount(M, { addressIndex: i });
    const b = (await client.readContract({
      address: USDC,
      abi: ABI,
      functionName: "balanceOf",
      args: [a.address],
    })) as bigint;
    total += b;
  }
  const forge = (await client.readContract({
    address: USDC,
    abi: ABI,
    functionName: "balanceOf",
    args: [FORGE],
  })) as bigint;
  const open = 139299992n; // battle opening total (USDC base units)
  const sys = total + forge;
  console.log("Wallets idx 0-13 USDC sum:", formatUnits(total, 6));
  console.log("Forge escrow USDC:        ", formatUnits(forge, 6));
  console.log("System total:             ", formatUnits(sys, 6));
  console.log("Battle opening total:      139.299992");
  console.log(
    "Drift since battle start: ",
    sys >= open ? `+${formatUnits(sys - open, 6)}` : `-${formatUnits(open - sys, 6)}`,
    "USDC",
  );
}
main();
