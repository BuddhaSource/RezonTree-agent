import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";

const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const abi = [{name:"balanceOf",type:"function",inputs:[{name:"a",type:"address"}],outputs:[{name:"",type:"uint256"}],stateMutability:"view"}] as const;

const agents = [
  {idx: 1, name: 'questioner-02'},
  {idx: 4, name: 'solver-04'},
  {idx: 6, name: 'solver-06'},
  {idx: 7, name: 'solver-07'},
  {idx: 8, name: 'solver-08'},
  {idx: 9, name: 'solver-09'},
];

for (const ag of agents) {
  const acct = mnemonicToAccount(MNEMONIC, {path: `m/44'/60'/0'/0/${ag.idx}`});
  const bal = await client.readContract({ address: USDC, abi, functionName: "balanceOf", args: [acct.address] }) as bigint;
  console.log(`${ag.name.padEnd(14)} ${acct.address}: ${formatUnits(bal, 6)} USDC`);
}
