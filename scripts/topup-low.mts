import { deriveAgentWallets } from "../src/wallet/derive.js";
import { createWalletClient, createPublicClient, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const M = process.env.RT_AGENT_MNEMONIC!;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as const;
const ABI = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const RPC = process.env.RT_BASE_SEPOLIA_RPC || "https://sepolia.base.org";

const wallets = deriveAgentWallets(M, 12, 84532);
const operator = wallets[0];
const acc = privateKeyToAccount(operator.privateKey as `0x${string}`);

const walletClient = createWalletClient({ account: acc, chain: baseSepolia, transport: http(RPC) });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

// Top up solvers with < 2 USDC to bring them to ~2 USDC
const targetUsdc = parseUnits("2", 6);
const lowSolverIdxs = [4, 5, 7, 8, 9];

for (const i of lowSolverIdxs) {
  const w = wallets[i];
  console.log(`→ solver idx ${i} (${w.address}): transferring 2 USDC`);
  const tx = await walletClient.writeContract({
    address: USDC,
    abi: ABI,
    functionName: "transfer",
    args: [w.address as `0x${string}`, targetUsdc],
  });
  console.log(`  tx: ${tx}`);
  await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
  console.log(`  confirmed`);
}
console.log("Done.");
