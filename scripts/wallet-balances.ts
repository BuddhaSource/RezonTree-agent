import { createPublicClient, http, formatUnits, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

async function main() {
  const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
  const USDC = (process.env.RT_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address;
  const MN = process.env.RT_AGENT_MNEMONIC!;
  const BANK = Number(process.env.RT_WALLET_BANK_SIZE ?? "30");
  const pc = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const ERC20_BALANCE = [{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}] as const;
  const rows: { idx: number; addr: Address; eth: string; usdc: string; usdcRaw: bigint }[] = [];
  for (let i = 0; i < BANK; i++) {
    const a = mnemonicToAccount(MN, { path: `m/44'/60'/0'/0/${i}` as const });
    const [eth, usdc] = await Promise.all([
      pc.getBalance({ address: a.address as Address }),
      pc.readContract({ address: USDC, abi: ERC20_BALANCE, functionName: "balanceOf", args: [a.address as Address] }) as Promise<bigint>,
    ]);
    rows.push({ idx: i, addr: a.address as Address, eth: formatUnits(eth, 18), usdc: formatUnits(usdc, 6), usdcRaw: usdc });
  }
  console.log("idx | addr                                       | ETH       | USDC");
  for (const r of rows) console.log(`${r.idx.toString().padStart(2)}  | ${r.addr} | ${r.eth.slice(0,9).padEnd(9)} | ${r.usdc}`);
  const totalUsdc = rows.reduce((s, r) => s + r.usdcRaw, 0n);
  const totalEth = rows.reduce((s, r) => s + parseFloat(r.eth), 0);
  console.log(`\nTotal: ${formatUnits(totalUsdc, 6)} USDC | ${totalEth.toFixed(6)} ETH`);
}
main().catch(e => { console.error(e); process.exit(1); });
