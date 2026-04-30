import { signWalletLoginIntent } from "../src/wallet/signer.js"
import { loadLoginDomain } from "../src/wallet/domain.js"
import { deriveAgentWallet } from "../src/wallet/derive.js"

const wallet = deriveAgentWallet(process.env.RT_AGENT_MNEMONIC!, 1, 84532)
const domain = loadLoginDomain(84532)
console.log("derived:", wallet.address)
console.log("domain:", domain)

const body = await signWalletLoginIntent({
  wallet,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  domain,
})
console.log("body:", body)

const r = await fetch("http://localhost:8080/auth/wallet", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
console.log("status:", r.status)
console.log("response:", await r.text())
