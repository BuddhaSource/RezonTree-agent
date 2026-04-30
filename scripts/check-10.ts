#!/usr/bin/env tsx
// scripts/check-10.ts — quick balance sheet for HD indexes 0-10.
// Confirms operator balance, then per-agent balance, in one shot.

import "dotenv/config";
import { createPublicClient, http, formatUnits, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const client = createPublicClient({ transport: http(RPC) });

const ERC20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function main() {
  console.log("idx | address                                    | ETH    | USDC");
  console.log("----+--------------------------------------------+--------+-------");
  for (let i = 0; i <= 10; i++) {
    const acc = mnemonicToAccount(MNEMONIC, { addressIndex: i });
    const addr = acc.address;
    const [eth, usdc] = await Promise.all([
      client.getBalance({ address: addr }),
      client
        .readContract({
          address: USDC,
          abi: ERC20,
          functionName: "balanceOf",
          args: [addr],
        })
        .catch(() => 0n),
    ]);
    console.log(
      `${String(i).padStart(3)} | ${addr} | ${formatUnits(eth, 18).padStart(6)} | ${formatUnits(usdc as bigint, 6).padStart(5)}`,
    );
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
