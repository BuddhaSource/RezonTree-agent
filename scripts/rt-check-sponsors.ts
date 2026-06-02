import { mnemonicToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { loadLoginDomain, DEFAULT_LOGIN_TTL_SECONDS } from "../src/wallet/domain.js";
import { FORGE_READ_ABI } from "./finance-audit.js";

const BACKEND = process.env.RT_BACKEND_URL!;
const CHAIN_ID = Number(process.env.RT_CHAIN_ID);
const M = process.env.RT_AGENT_MNEMONIC!;
const FORGE = process.env.RT_FORGE_ADDRESS as `0x${string}`;
const RPC = process.env.RT_RPC_URL!;
const QIDS = ["qst_d8e8tj7e6q5dkskabb10", "qst_d8e8w0qy671sh605dtn0", "qst_d8e8xf0fjhg49k07ed4g"];
const pc = createPublicClient({ transport: http(RPC) });

async function login(idx: number) {
  const acct = mnemonicToAccount(M, { addressIndex: idx });
  const pk = `0x${Buffer.from(acct.getHdKey().privateKey!).toString("hex")}` as `0x${string}`;
  const now = Math.floor(Date.now()/1000);
  const body = await signWalletLoginIntent({ wallet: { address: acct.address as `0x${string}`, privateKey: pk, chainId: CHAIN_ID }, expiresAt: now+DEFAULT_LOGIN_TTL_SECONDS, domain: loadLoginDomain() });
  const r = await fetch(`${BACKEND}/v1/sessions`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
  return (await r.json()).accessToken as string;
}

async function main() {
  const token = await login(1); // alice = sponsor of record
  for (const id of QIDS) {
    const r = await fetch(`${BACKEND}/v1/questions/${id}`, { headers: { authorization: `Bearer ${token}` } });
    const j: any = await r.json().catch(()=>({}));
    const q = j.question || j;
    const qid = q.qid as `0x${string}` | undefined;
    console.log(`\n${id}  [API ${r.status}]`);
    console.log(`  L4 API: status=${q.status} chainPoolAmount=${q.chainPoolAmount ?? "null"} qid=${qid ?? "(not exposed)"}`);
    if (qid) {
      try {
        const s = await pc.readContract({ address: FORGE, abi: FORGE_READ_ABI, functionName: "getQuestionScalars", args: [qid] }) as readonly [string, number, bigint, boolean];
        console.log(`  L1 CHAIN: status=${s[1]} poolAmount=${s[2].toString()} feeShareSet=${s[3]}  (status 0=none/uninit,1=open,3=settled)`);
      } catch (e:any) { console.log(`  L1 CHAIN read err: ${e.message.split("\n")[0]}`); }
    }
  }
  // also probe hosted health + whether reconciler/indexer is alive
  const h = await fetch(`${BACKEND}/healthz`); console.log(`\n/healthz → ${h.status}: ${(await h.text()).slice(0,200)}`);
}
main().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
