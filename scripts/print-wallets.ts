import { mnemonicToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

const rpc = process.env.FORGE_RPC_URL || "https://sepolia.base.org";
const usdc = (process.env.RT_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;
const mnemonic = process.env.RT_AGENT_MNEMONIC!;

const labels = [
  "operator (idx 0)", "questioner-01 (idx 1)", "questioner-02 (idx 2)",
  "solver-02 (idx 3)", "solver-03 (idx 4)", "solver-04 (idx 5)", "solver-05 (idx 6)",
  "solver-06 (idx 7)", "solver-07 (idx 8)", "solver-08 (idx 9)", "solver-09 (idx 10)",
  "spare-11", "spare-12", "spare-13",
];

const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];

async function main() {
  console.log("idx  address                                       ETH (gas)     USDC         role");
  console.log("---  --------------------------------------------  ------------  -----------  -------------------------");
  for (let i = 0; i < 14; i++) {
    const acc = mnemonicToAccount(mnemonic, { addressIndex: i });
    const [ethWei, usdcBase] = await Promise.all([
      client.getBalance({ address: acc.address }),
      client.readContract({
        address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [acc.address],
      }) as Promise<bigint>,
    ]);
    const eth = Number(formatUnits(ethWei, 18)).toFixed(5).padStart(10);
    const u = Number(formatUnits(usdcBase, 6)).toFixed(4).padStart(9);
    console.log(`${i.toString().padStart(2)}   ${acc.address}  ${eth}    ${u}    ${labels[i]}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
