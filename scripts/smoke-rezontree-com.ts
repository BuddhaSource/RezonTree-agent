import { mnemonicToAccount } from "viem/accounts";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { loadLoginDomain, DEFAULT_LOGIN_TTL_SECONDS } from "../src/wallet/domain.js";

const BACKEND = process.env.RT_BACKEND_URL!;
const CHAIN_ID = Number(process.env.RT_CHAIN_ID);
const M = process.env.RT_AGENT_MNEMONIC!;
const domain = loadLoginDomain();
console.log("login domain:", JSON.stringify(domain));

async function main() {
  const acct = mnemonicToAccount(M, { addressIndex: 1 }); // alice
  const pk = `0x${Buffer.from(acct.getHdKey().privateKey!).toString("hex")}` as `0x${string}`;
  const wallet = { address: acct.address as `0x${string}`, privateKey: pk, chainId: CHAIN_ID };
  console.log("wallet (alice):", wallet.address);

  const now = Math.floor(Date.now() / 1000);
  const body = await signWalletLoginIntent({ wallet, expiresAt: now + DEFAULT_LOGIN_TTL_SECONDS, domain });

  const res = await fetch(`${BACKEND}/v1/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("POST /v1/sessions →", res.status);
  if (!res.ok) { console.log(text.slice(0, 600)); process.exit(2); }
  const j = JSON.parse(text);
  const token = j.accessToken || j.access_token || j.token || j.jwt;
  console.log("JWT:", token ? token.slice(0, 20) + "…" : "(none)", "| resp keys:", Object.keys(j).join(","));

  const me = await fetch(`${BACKEND}/v1/accounts/${wallet.address}?include=wallet`, {
    headers: { authorization: `Bearer ${token}`, Prefer: "return=minimal" },
  });
  console.log("GET /v1/accounts/:addr?include=wallet →", me.status);
  console.log((await me.text()).slice(0, 700));
}
main().catch((e) => { console.error("SMOKE ERR:", e.message); process.exit(1); });
