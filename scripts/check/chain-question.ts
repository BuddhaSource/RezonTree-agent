import { createPublicClient, http } from "viem";

const FORGE = (process.env.RT_FORGE_ADDRESS ?? "0x5b9e716b6f93dc894c220fed1616edae4bc56926") as `0x${string}`;
const QID = process.argv[2] as `0x${string}`;
if (!QID) { console.error("usage: check-chain <qid_hex>"); process.exit(2); }

const client = createPublicClient({ transport: http(process.env.RT_RPC_URL ?? "https://sepolia.base.org") });

(async () => {
  const out = await client.readContract({
    address: FORGE,
    abi: [{
      name: "questions", type: "function", stateMutability: "view",
      inputs: [{ name: "qid", type: "bytes32" }],
      outputs: [{
        name: "", type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "oracle", type: "address" },
          { name: "token", type: "address" },
          { name: "stakeFloor", type: "uint128" },
          { name: "voteFee", type: "uint64" },
          { name: "stakeBasisPoints", type: "uint16" },
          { name: "sponsorshipFloor", type: "uint128" },
          { name: "abandonmentGracePeriod", type: "uint64" },
          { name: "fundingDeadline", type: "uint64" },
          { name: "totalPool", type: "uint128" },
          { name: "totalClaimable", type: "uint128" },
          { name: "merkleRoot", type: "bytes32" },
        ],
      }],
    }],
    functionName: "questions",
    args: [QID],
  });
  console.log(JSON.stringify({
    status: Number((out as { status: number }).status),
    totalPool: (out as { totalPool: bigint }).totalPool.toString(),
    stakeFloor: (out as { stakeFloor: bigint }).stakeFloor.toString(),
    voteFee: (out as { voteFee: bigint }).voteFee.toString(),
    oracle: (out as { oracle: string }).oracle,
    token: (out as { token: string }).token,
  }, null, 2));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
