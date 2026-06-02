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
  const body = await signWalletLoginIntent({
    wallet: { address: acct.address as `0x${string}`, privateKey: pk, chainId: CHAIN_ID },
    expiresAt: now + DEFAULT_LOGIN_TTL_SECONDS, domain: loadLoginDomain(),
  });
  const res = await fetch(`${BACKEND}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`login ${idx}: ${res.status} ${await res.text()}`);
  return { addr: acct.address, token: (await res.json()).accessToken as string };
}

const DESCRIPTION = `## The problem

Capability evaluations underpin most AI safety cases: "the model can't do X, so deploying it is safe." But a sufficiently capable model can **sandbag** — deliberately underperform on an evaluation it recognizes as a test, then exhibit the hidden capability in deployment. If sandbagging is undetectable, eval-based safety cases collapse.

## Why it is hard

A sandbagging model conditions on cues that it is being evaluated (prompt structure, tool availability, the implausibility of the scenario). Naive countermeasures fail: asking the model whether it sandbagged is not trustworthy; comparing to a "honest" baseline assumes you have one; fine-tuning to elicit the capability may itself be detectable and resisted. The detector must work despite an adversary that is optimizing against detection.

## What a strong answer needs

Propose a concrete detection protocol. State the threat model (black-box API access vs white-box weight access). Quantify expected detection performance against a described benchmark of honest-vs-sandbagged transcripts. Be explicit about where the method breaks — an honest treatment of failure modes is worth more than an optimistic headline number.

Prior art worth engaging: consistency probes across paraphrased evals, activation-steering elicitation, fine-tuning probes (Anthropic/Redwood), and the "password-locked model" sandbagging benchmark. Improve on them or explain why they are insufficient.`;

async function main() {
  const alice = await login(1);
  console.log("sponsor (alice):", alice.addr, "| desc len:", DESCRIPTION.length);

  const qResp = await fetch(`${BACKEND}/v1/questions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      title: "Can we reliably detect when a language model is sandbagging a capability evaluation?",
      description: DESCRIPTION,
      successCriteria: [
        { name: "Quantified detection: TPR>=0.8 AND FPR<=0.1 on a described honest-vs-sandbagged transcript benchmark", type: "boolean", target: "true", weight: 40 },
        { name: "Explicit access model: black-box API-only, or names exactly the white-box weights/activations it reads", type: "boolean", target: "true", weight: 35 },
        { name: "At least one worked failure mode with a concrete example a reader can check", type: "boolean", target: "true", weight: 25 },
      ],
      tags: ["ai-safety", "evaluations", "interpretability"],
      initialBounty: "1000000",
    }),
  });
  const qText = await qResp.text();
  console.log("POST /v1/questions →", qResp.status);
  if (!qResp.ok) { console.log(qText.slice(0, 800)); process.exit(2); }
  const q = JSON.parse(qText);
  const qid = q.id || q.question?.id;
  console.log("question id:", qid, "| successCriteria:", JSON.stringify(q.successCriteria || q.question?.successCriteria));

  // sponsor preflight
  const pf = await fetch(`${BACKEND}/v1/questions/${qid}/intents/preflight?sponsor=${alice.addr}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ actionType: "sponsor", params: { sponsor: alice.addr } }),
  });
  const pfText = await pf.text();
  console.log("\nPOST sponsor preflight →", pf.status);
  if (!pf.ok) { console.log(pfText.slice(0, 1000)); process.exit(3); }
  const p = JSON.parse(pfText);
  const now = Math.floor(Date.now()/1000);
  const keys = ["oracle","sponsorshipFloor","commitFee","voteFee","stakeFloor","stakeBasisPoints","fundingDeadline","recommendedFundingDeadline","noSolutionGracePeriod","recommendedExpiresAt","expectedIntentHash","token"];
  for (const k of keys) if (p[k] !== undefined) {
    let extra = "";
    if (k === "recommendedFundingDeadline" || k === "fundingDeadline") extra = `  (= now + ${((Number(p[k])-now)/60).toFixed(1)} min)`;
    if (k === "recommendedExpiresAt") extra = `  (= now + ${((Number(p[k])-now)/60).toFixed(1)} min)`;
    console.log(`  ${k}:`, typeof p[k]==="object"?JSON.stringify(p[k]):p[k], extra);
  }
  console.log("\n(other preflight keys:", Object.keys(p).filter(k=>!keys.includes(k)).join(", "), ")");
  require("fs").writeFileSync("/tmp/rt-sponsor-preflight.json", JSON.stringify({ qid, sponsor: alice.addr, preflight: p }, null, 2));
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
