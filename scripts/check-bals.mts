import { deriveAgentWallets } from "../src/wallet/derive.js";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

async function main() {
  const m = process.env.RT_AGENT_MNEMONIC!;
  const wallets = deriveAgentWallets(m, 12, 84532);
  const rpc = process.env.RT_BASE_SEPOLIA_RPC || process.env.NEXT_PUBLIC_RT_RPC_BASE_SEPOLIA || "https://sepolia.base.org";
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const usdc = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as const;
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

  const rows = await Promise.all(wallets.map(async (w, i) => {
    const [usdcBal, ethBal] = await Promise.all([
      client.readContract({ address: usdc, abi, functionName: "balanceOf", args: [w.address as `0x${string}`] }),
      client.getBalance({ address: w.address as `0x${string}` }),
    ]);
    return { i, addr: w.address, usdc: Number(formatUnits(usdcBal, 6)), eth: Number(formatUnits(ethBal, 18)) };
  }));

  console.log("role          idx  address                                       USDC          ETH (gas)");
  console.log("------------  ---  --------------------------------------------  ------------  ----------");
  const role = (i: number) => i === 0 ? "operator" : i <= 2 ? "questioner   " : "solver      ";
  for (const r of rows) {
    console.log(`${role(r.i)}  ${String(r.i).padStart(3)}  ${r.addr}  ${r.usdc.toFixed(4).padStart(12)}  ${r.eth.toFixed(6).padStart(10)}`);
  }
  const total = rows.reduce((s, r) => s + r.usdc, 0);
  console.log(`------------  ---  total                                         ${total.toFixed(4).padStart(12)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
