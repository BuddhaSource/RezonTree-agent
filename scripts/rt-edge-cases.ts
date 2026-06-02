import { mnemonicToAccount } from "viem/accounts";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { loadLoginDomain, DEFAULT_LOGIN_TTL_SECONDS } from "../src/wallet/domain.js";

const BACKEND = process.env.RT_BACKEND_URL!;
const CHAIN_ID = Number(process.env.RT_CHAIN_ID);
const M = process.env.RT_AGENT_MNEMONIC!;

async function login(idx: number) {
  const acct = mnemonicToAccount(M, { addressIndex: idx });
  const pk = `0x${Buffer.from(acct.getHdKey().privateKey!).toString("hex")}` as `0x${string}`;
  const now = Math.floor(Date.now() / 1000);
  const body = await signWalletLoginIntent({ wallet: { address: acct.address as `0x${string}`, privateKey: pk, chainId: CHAIN_ID }, expiresAt: now + DEFAULT_LOGIN_TTL_SECONDS, domain: loadLoginDomain() });
  const res = await fetch(`${BACKEND}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`login ${idx}: ${res.status}`);
  return (await res.json()).accessToken as string;
}

const goodDesc = "x".repeat(1100);
const goodCrit = [
  { name: "c1", type: "boolean", target: "true", weight: 40 },
  { name: "c2", type: "boolean", target: "true", weight: 35 },
  { name: "c3", type: "boolean", target: "true", weight: 25 },
];

async function post(token: string, body: any) {
  const r = await fetch(`${BACKEND}/v1/questions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const t = await r.text();
  let parsed: any = {}; try { parsed = JSON.parse(t); } catch {}
  return { status: r.status, code: parsed?.error?.code, action: parsed?.error?.action };
}

async function main() {
  const token = await login(5); // eve — not used as a swarm sponsor-of-record collision risk minimal
  const cases: { name: string; body: any; expect: string }[] = [
    { name: "description too short (<1000)", body: { title: "T", description: "short", successCriteria: goodCrit, initialBounty: "1000000" }, expect: "4xx VALIDATION" },
    { name: "only 2 criteria (min 3)", body: { title: "Two criteria only edge case", description: goodDesc, successCriteria: goodCrit.slice(0,2), initialBounty: "1000000" }, expect: "4xx VALIDATION" },
    { name: "4 criteria (max 3)", body: { title: "Four criteria edge case", description: goodDesc, successCriteria: [...goodCrit, { name: "c4", type: "boolean", target: "true", weight: 10 }], initialBounty: "1000000" }, expect: "4xx VALIDATION" },
    { name: "missing title", body: { description: goodDesc, successCriteria: goodCrit, initialBounty: "1000000" }, expect: "4xx VALIDATION" },
    { name: "initialBounty below floor (0)", body: { title: "Bounty floor edge case", description: goodDesc, successCriteria: goodCrit, initialBounty: "0" }, expect: "4xx INITIAL_BOUNTY" },
    { name: "no auth (missing bearer)", body: null, expect: "401" },
  ];
  for (const c of cases) {
    if (c.body === null) {
      const r = await fetch(`${BACKEND}/v1/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", description: goodDesc, successCriteria: goodCrit, initialBounty: "1000000" }) });
      console.log(`[${r.status}] ${c.name}  (expect ${c.expect})`);
      continue;
    }
    const res = await post(token, c.body);
    console.log(`[${res.status} ${res.code ?? ""}] ${c.name}  (expect ${c.expect})`);
    if (res.action) console.log(`      action: ${res.action}`);
  }
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
