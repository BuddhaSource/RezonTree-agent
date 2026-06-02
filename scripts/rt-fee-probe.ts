// rt-fee-probe.ts — read the hosted backend's fee config authoritatively,
// then query the chain's accruedFees() for the real recipient.
import { createPublicClient, http, getAddress, formatUnits, type Address } from "viem";
import { loginWallet } from "./lib/operator-recovery.js";

const API = (process.env.RT_BACKEND_URL ?? "https://rezontree.com").replace(/\/$/, "");
const FORGE = getAddress(process.env.RT_FORGE_ADDRESS as string);
const USDC = getAddress((process.env.RT_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const M = process.env.RT_AGENT_MNEMONIC!;

const ACCRUED_ABI = [{ type: "function", name: "accruedFees", stateMutability: "view", inputs: [{ name: "recipient", type: "address" }, { name: "token", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

async function accrued(client: any, recipient: Address): Promise<bigint> {
  return (await client.readContract({ address: FORGE, abi: ACCRUED_ABI, functionName: "accruedFees", args: [recipient, USDC] })) as bigint;
}

async function main() {
  const client = createPublicClient({ transport: http(RPC) });
  const { bearer, address } = await loginWallet(API, M, 0);
  console.log(`probe | api=${API} forge=${FORGE} usdc=${USDC} | login idx0=${address}`);

  // 1) /v1/protocol — does it advertise the fee config?
  const proto: any = await (await fetch(`${API}/v1/protocol`)).json().catch(() => ({}));
  const protoStr = JSON.stringify(proto);
  const feeHits = protoStr.match(/"[^"]*[Ff]ee[^"]*":\s*("[^"]*"|\d+)/g) || [];
  console.log(`\n/v1/protocol fee-ish fields: ${feeHits.slice(0, 12).join("  ") || "(none surfaced)"}`);

  // 1b) inspect 2 settled questions — did the keeper actually emit a non-zero feeTotal / feeDistributions?
  const board: any = await (await fetch(`${API}/v1/questions?limit=100`)).json().catch(() => ({}));
  const qs: any[] = board.questions || board.data || [];
  const settled = qs.filter((q) => q.status === "settled").slice(0, 3);
  console.log(`\nsettled-question fee inspection (${settled.length} sampled):`);
  for (const sq of settled) {
    const res: any = await (await fetch(`${API}/v1/questions/${sq.id}/result`)).json().catch(() => ({}));
    const set: any = await (await fetch(`${API}/v1/questions/${sq.id}/settlement`)).json().catch(() => ({}));
    const feeish = JSON.stringify({ result: res, settlement: set }).match(/"[^"]*([Ff]ee|[Pp]latform)[^"]*":\s*("[^"]*"|\d+|\[[^\]]*\])/g) || [];
    console.log(`  ${sq.id}: ${feeish.slice(0, 8).join("  ") || "(no fee fields surfaced)"}`);
  }

  // 2) create a throwaway draft question, then sponsor-preflight it to read live platformFeeRecipient + feeShareBps
  const qr = await fetch(`${API}/v1/questions`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "fee-probe draft (never funded)",
      description: "Transient draft created only to read the sponsor-preflight fee config. Safe to ignore/expire.",
      successCriteria: [
        { name: "criterion_one", type: "boolean", target: "true", weight: 40 },
        { name: "criterion_two", type: "boolean", target: "true", weight: 35 },
        { name: "criterion_three", type: "boolean", target: "true", weight: 25 },
      ],
      initialBounty: "1000000",
    }),
  });
  const q: any = await qr.json().catch(() => ({}));
  const qid = q.id ?? q?.data?.id;
  console.log(`draft question: ${qr.status} id=${qid ?? "(none)"}`);
  if (qid) {
    const pr = await fetch(`${API}/v1/questions/${qid}/intents/preflight?sponsor=${address}`, {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ actionType: "sponsor", params: { sponsor: address } }),
    });
    const pre: any = await pr.json().catch(() => ({}));
    console.log(`sponsor preflight: ${pr.status}`);
    console.log(`  platformFeeRecipient: ${pre.platformFeeRecipient ?? "(none)"}`);
    console.log(`  feeShareBps:          ${pre.feeShareBps ?? "(none)"}`);
    console.log(`  feeShares:            ${JSON.stringify(pre.feeShares ?? "(none)")}`);
    if (pr.status >= 400) console.log(`  err: ${JSON.stringify(pre).slice(0, 300)}`);

    // 3) query accruedFees on whatever recipient the backend named (+ the two prior guesses)
    const candidates = new Set<string>();
    if (pre.platformFeeRecipient) candidates.add(getAddress(pre.platformFeeRecipient));
    candidates.add(getAddress("0x55Bd1aAE425116048590db9dC978f47b4F3702b5"));
    candidates.add(getAddress("0xF0c36CAC44cA127aae7e31c1913AfBA677E24501"));
    console.log(`\naccruedFees(recipient, USDC) on forge ${FORGE}:`);
    for (const c of candidates) {
      const a = await accrued(client, c as Address);
      console.log(`  ${c}  →  ${a.toString()} base units  (${formatUnits(a, 6)} USDC)`);
    }
  }
}
main().catch((e) => { console.error("PROBE ERROR:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
