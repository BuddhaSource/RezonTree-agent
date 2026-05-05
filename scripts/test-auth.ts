import { mnemonicToAccount } from "viem/accounts"
import { http, createWalletClient } from "viem"
import { baseSepolia } from "viem/chains"

const mnemonic = process.env.RT_AGENT_MNEMONIC!
const acc = mnemonicToAccount(mnemonic, { addressIndex: 1 })
const wallet = createWalletClient({ account: acc, chain: baseSepolia, transport: http() })

const expiresAt = Math.floor(Date.now() / 1000) + 600  // +10 min
const intent = {
  ethAddress: acc.address,
  chainId: 84532,
  expiresAt,
  nonce: BigInt(0),
}
const sig = await wallet.signTypedData({
  account: acc,
  domain: { name: "RezonTreeAuth", version: "1", chainId: 84532 },
  types: {
    WalletLoginIntent: [
      { name: "ethAddress",  type: "address" },
      { name: "chainId",     type: "uint256" },
      { name: "expiresAt",   type: "uint256" },
      { name: "nonce",       type: "uint256" },
    ],
  },
  primaryType: "WalletLoginIntent",
  message: intent,
})
const r = await fetch("http://localhost:8080/auth/wallet", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: acc.address,
    chainId: 84532,
    expiresAt: expiresAt,
    signature: sig,
  }),
})
console.log("status:", r.status)
console.log("body:", await r.text())
