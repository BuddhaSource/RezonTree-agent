import { mnemonicToAccount } from "viem/accounts"
import { createPublicClient, http, formatEther, formatUnits, erc20Abi } from "viem"
import { baseSepolia } from "viem/chains"

const mnemonic = process.env.RT_AGENT_MNEMONIC!
const RPC = process.env.RT_RPC_URL || "https://sepolia.base.org"
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) })

const labels = [
  ["operator/oracle", 0],
  ["alice (sponsor)", 1],
  ["bob (solver/voter)", 2],
] as const

for (const [label, idx] of labels) {
  const acc = mnemonicToAccount(mnemonic, { addressIndex: idx })
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address: acc.address }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [acc.address] }),
  ])
  console.log(`${label.padEnd(20)} ${acc.address}  ETH=${formatEther(eth).padStart(8)}  USDC=${formatUnits(usdc, 6)}`)
}
