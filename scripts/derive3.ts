import { mnemonicToAccount } from "viem/accounts"
const mnemonic = process.env.RT_AGENT_MNEMONIC
if (!mnemonic) throw new Error("RT_AGENT_MNEMONIC missing")
const labels = ["operator/oracle (idx 0)", "alice — primary sponsor (idx 1)", "bob — primary solver/voter (idx 2)"]
for (let i = 0; i < 3; i++) {
  const acc = mnemonicToAccount(mnemonic, { addressIndex: i })
  console.log(`${labels[i]}: ${acc.address}`)
}
