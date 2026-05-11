import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

const FORGE = process.env.RT_FORGE_ADDRESS as `0x${string}`;
const pub = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.FORGE_RPC_URL || "https://sepolia.base.org"),
});

const ABI = [
  {
    name: "sponsorPoolByAddress",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "q", type: "bytes32" },
      { name: "s", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

const cases: [string, `0x${string}`, string][] = [
  ["0xc4165fcfce718ec22bf07c4c82911e191dd5ea2e9cfaf838920dba2112076ce8", "0x483c51061e6106fe4e08E138428336A519fC0533", "qst_d7zaps... idx 1, was 5"],
  ["0x95f5072fe3095a237cacb7ee0a5cf814a65e99dbe25a8e53c67d2eaf198155e6", "0x483c51061e6106fe4e08E138428336A519fC0533", "qst_d7x8zx... idx 1, was 1, REVERTED"],
  ["0x2056ef2cfd1d111c1e9842daefb93fc2bbd10197e1835dc79e21ffd091db5d35", "0x42f77513Cbb4C9166e14A1bf703c82d023c2f16c", "qst_d7zav8... idx 6, was 1"],
];

async function main() {
  for (const [qid, sp, label] of cases) {
    const pool = (await pub.readContract({
      address: FORGE,
      abi: ABI,
      functionName: "sponsorPoolByAddress",
      args: [qid as `0x${string}`, sp],
    })) as bigint;
    console.log(`${label}: chain pool = ${formatUnits(pool, 6)} USDC`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
