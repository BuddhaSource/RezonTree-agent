// rt-balance-survey.ts — USDC + ETH survey across the bulb wallet bank.
import { createPublicClient, http, fallback, formatUnits, formatEther, parseAbiItem, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { deriveAgentWallet } from "../src/wallet/derive.js";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const USDC = (process.env.RT_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address;
const CHAIN_ID = Number(process.env.RT_CHAIN_ID ?? "84532");
const N = Number(process.env.RT_BANK_SCAN ?? "16");
const NAMES = ["oracle","alice","bob","carol","dave","eve","frank","grace","heidi","ivan","judy","ken","leo","mia","nia","omar"];
const BAL = parseAbiItem("function balanceOf(address) view returns (uint256)");
const pub = createPublicClient({ chain: baseSepolia, transport: fallback(["https://sepolia.base.org","https://base-sepolia-rpc.publicnode.com"].map((u)=>http(u))) });
async function main() {
  let tU=0n,tE=0n;
  console.log(`bank survey | chain ${CHAIN_ID}\nidx name     address                                      USDC        ETH`);
  for (let i=0;i<N;i++){
    const w=deriveAgentWallet(MNEMONIC,i,CHAIN_ID); const a=w.address as Address;
    const [u,e]=await Promise.all([
      pub.readContract({address:USDC,abi:[BAL],functionName:"balanceOf",args:[a]}) as Promise<bigint>,
      pub.getBalance({address:a}),
    ]);
    tU+=u; tE+=e;
    console.log(`${String(i).padStart(2)} ${(NAMES[i]??`idx${i}`).padEnd(7)} ${a}  ${formatUnits(u,6).padStart(10)}  ${Number(formatEther(e)).toFixed(4).padStart(8)}${u>0n?" 💰":""}`);
  }
  console.log(`\nΣ USDC: ${formatUnits(tU,6)}  |  Σ ETH: ${Number(formatEther(tE)).toFixed(4)}`);
}
main().catch((e)=>{console.error(e);process.exit(1);});
