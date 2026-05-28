import "dotenv/config";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";

async function main() {
  const API = process.env.RT_AGENT_BACKEND_URL!;
  const M = process.env.RT_AGENT_MNEMONIC!;
  const domain = loadLoginDomain();
  const wallet = deriveAgentWallet(M, 5, domain.chainId);
  const body = await signWalletLoginIntent({ wallet, expiresAt: Math.floor(Date.now() / 1000) + 300, domain });
  const r = await fetch(`${API}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const { accessToken } = (await r.json()) as any;
  const p = await fetch(
    `${API}/v1/questions/qst_d86y7xtrce5fpekpczd0/intents/preflight?submitter=${wallet.address}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ actionType: "commit", params: { submitter: wallet.address } }),
    },
  );
  console.log("status:", p.status);
  console.log("body:", await p.text());
}
main().catch((e) => { console.error(e); process.exit(1); });
