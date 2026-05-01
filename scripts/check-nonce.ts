#!/usr/bin/env tsx
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const c = createPublicClient({ transport: http("https://sepolia.base.org") });
const FORGE = "0x6c70fb6f59e1f2c3b9456a30c3856be0032300d1";
const ABI = [
  {
    type: "function",
    name: "consumedNonces",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function lowestUnusedNonce(addr: `0x${string}`): Promise<bigint> {
  for (let word = 0n; word < 100n; word++) {
    const bitmap = (await c.readContract({
      address: FORGE,
      abi: ABI,
      functionName: "consumedNonces",
      args: [addr, word],
    })) as bigint;
    if (bitmap === (1n << 256n) - 1n) continue; // all bits used in this word
    for (let i = 0n; i < 256n; i++) {
      if (((bitmap >> i) & 1n) === 0n) return word * 256n + i;
    }
  }
  return 25600n;
}

async function main() {
  const m = process.env.RT_AGENT_MNEMONIC!;
  console.log("idx | address                                    | next unused nonce");
  console.log("----+--------------------------------------------+-------------------");
  for (let i = 0; i <= 13; i++) {
    const addr = mnemonicToAccount(m, { addressIndex: i }).address;
    const nonce = await lowestUnusedNonce(addr);
    console.log(`${String(i).padStart(3)} | ${addr} | ${nonce.toString()}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
