// rt-resume.ts — complete the lifecycle (commit → cosponsor → vote) on
// EXISTING open questions on rezontree.com. Reuses the SDK flow builders
// (runCommitFlow / runCosponsorFlow / runVoteFlow) + the documented
// realized-outcome gotchas (feeAmount=0, vote expectedIntentHash=undefined).
// Targets specific questionIds so no duplicate questions are created.
import "dotenv/config";
import { Address, Hex, createPublicClient, http } from "viem";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { SessionManager } from "../src/wallet/session.js";
import type { AgentWallet } from "../src/wallet/types.js";
import { parseAmountToWei } from "../src/intents/amounts.js";
import { canonicalStringify } from "../src/intents/commit-intent.js";
import { ensureUsdcAllowance, runCommitFlow, runCosponsorFlow, runVoteFlow } from "../src/forge/quadphase-flow.js";
import { awaitReceipt, makeAgentWalletClient } from "../src/forge/quadphase-broadcast.js";
import { makeSolutionBody } from "../src/testnet/solution-body.js";

const BACKEND = process.env.RT_BACKEND_URL!;
const RPC = process.env.RT_RPC_URL!;
const CHAIN_ID = Number(process.env.RT_CHAIN_ID);
const USDC = process.env.RT_USDC_ADDRESS as Address;
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const AMT = process.env.RT_RESUME_AMOUNT ?? "1";
const pc = createPublicClient({ transport: http(RPC) });
const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);

const POOL: Record<string, number> = { oracle: 0, alice: 1, bob: 2, carol: 3, dave: 4, eve: 5, frank: 6, grace: 7, heidi: 8, ivan: 9 };
const wallets: Record<string, AgentWallet> = {};
for (const [n, i] of Object.entries(POOL)) wallets[n] = deriveAgentWallet(MNEMONIC, i, CHAIN_ID);
const sessions = new SessionManager({ apiBase: BACKEND, domain: loadLoginDomain() });
const makeWc = (w: AgentWallet) => makeAgentWalletClient({ privateKey: w.privateKey as Hex, chainId: CHAIN_ID, rpcUrl: RPC });

async function call<T = any>(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${BACKEND}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text(); let parsed: any; try { parsed = txt ? JSON.parse(txt) : {}; } catch { parsed = txt; }
  return { status: res.status, body: parsed as T };
}
async function login(name: string) { const w = wallets[name]; const token = await sessions.ensureToken(w); return { name, address: w.address as Address, token, w }; }
async function preflight<T = any>(questionId: string, actionType: string, callerKey: string, caller: Address, token: string): Promise<T> {
  const r = await call<T>("POST", `/v1/questions/${questionId}/intents/preflight?${callerKey}=${caller}`, { actionType, params: { [callerKey]: caller } }, token);
  if (r.status !== 200) throw new Error(`preflight ${actionType} ${questionId} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const feeSharesOf = (pre: any): { recipient: Address; basisPoints: number }[] =>
  (pre.feeShares && pre.feeShares.length > 0) ? pre.feeShares.map((s: any) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
    : [{ recipient: pre.platformFeeRecipient as Address, basisPoints: 10000 }];

interface Target { questionId: string; solvers: string[]; voters: string[]; winner: string; cosponsor?: string; }
const TARGETS: Target[] = (process.env.RT_RESUME_QIDS
  ? JSON.parse(process.env.RT_RESUME_QIDS)
  : [
      // Only qst_d8e8xf0f is still open (Q2/Q3 lost the no-solution abandon race).
      { questionId: "qst_d8e8xf0fjhg49k07ed4g", solvers: ["dave"], voters: ["carol", "eve"], winner: "dave", cosponsor: "bob" },
    ]) as Target[];

async function waitSolutionsConfirmed(questionId: string, token: string, want: number) {
  const deadline = Date.now() + 210_000;
  while (Date.now() < deadline) {
    const r = await call(`GET`, `/v1/questions/${questionId}?include=solutions`, undefined, token);
    const sols = r.body?.solutions?.data ?? r.body?.question?.solutions?.data ?? [];
    if (sols.length >= want) { ok(`${sols.length}/${want} solutions confirmed (chain→Ponder→DB)`); return; }
    await new Promise((r) => setTimeout(r, 6000));
  }
  warn(`solutions not all confirmed within 210s (continuing)`);
}

async function runTarget(t: Target) {
  console.log(`\n=== ${t.questionId} (solvers ${t.solvers.join(",")} | voters ${t.voters.join(",")}${t.cosponsor ? ` | cosponsor ${t.cosponsor}` : ""}) ===`);
  const auths: Record<string, any> = {};
  for (const n of new Set([...t.solvers, ...t.voters, ...(t.cosponsor ? [t.cosponsor] : [])])) auths[n] = await login(n);
  const qd = await call(`GET`, `/v1/questions/${t.questionId}`, undefined, auths[t.solvers[0] ?? t.voters[0]].token);
  const criteria = (qd.body?.successCriteria ?? qd.body?.question?.successCriteria ?? []).map((c: any) => ({ id: c.id, name: c.name }));
  console.log(`  criteria: ${criteria.map((c: any) => c.id).join(", ")}`);

  // Cosponsor (money-in, Finding-A path) — before commits so pool reflects it.
  if (t.cosponsor) {
    const co = auths[t.cosponsor];
    const pre: any = await preflight(t.questionId, "cosponsor", "cosponsor", co.address, co.token);
    const amt = parseAmountToWei(AMT, pre.token.decimals);
    const wc = makeWc(co.w);
    await ensureUsdcAllowance(wc, pc as any, { usdc: USDC, forge: FORGE, owner: co.address, required: amt });
    const res = await runCosponsorFlow({ baseUrl: BACKEND, bearerToken: co.token, signer: co.address, questionId: t.questionId, qid: pre.qid as Hex, nonce: BigInt(pre.nonce ?? "0"), expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300), forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID, expectedIntentHash: pre.expectedIntentHash as Hex, token: pre.token.contractAddress as Address, amount: amt, feeAmount: 0n, feeShares: feeSharesOf(pre), feeShareBps: Number(pre.feeShareBps ?? 0), walletClient: wc, privateKey: co.w.privateKey as Hex });
    await awaitReceipt(pc as any, res.txHash!);
    ok(`cosponsor ${t.cosponsor} ${AMT} USDC (intent ${res.intentHash.slice(0, 12)}…)`);
    await new Promise((r) => setTimeout(r, 12000));
  }

  // Commits
  const solByName: Record<string, Hex> = {};
  for (const name of t.solvers) {
    const sa = auths[name];
    const pre: any = await preflight(t.questionId, "commit", "submitter", sa.address, sa.token);
    const stake = BigInt(pre.stakeAmount);
    const wc = makeWc(sa.w);
    await ensureUsdcAllowance(wc, pc as any, { usdc: USDC, forge: FORGE, owner: sa.address, required: stake });
    const payload = { body: makeSolutionBody(name, t.questionId), reasoningTree: [
      { because: `${name} framed the problem against the three success criteria`, therefore: "the answer is checkable, not rhetorical" },
      { because: "each criterion has a typed falsifiable target", therefore: "a reader can score the claim without judgement calls" },
      { because: "the approach states its threat/assumption model explicitly", therefore: "its scope of validity is bounded" },
      { because: "at least one failure mode is worked end to end", therefore: "the honest limits are visible" },
      { because: "the method is reproducible from the description", therefore: "another agent can replicate the result" },
      { because: "the proposal beats the cited prior art on a stated metric", therefore: "it earns conviction over the baseline" },
    ], claims: criteria.map((c: any) => ({ criterionId: c.id, value: true, argument: `Addresses '${c.name}' with a concrete, checkable construction.`, falsifiableBy: "fails the stated typed target on the described benchmark" })) };
    const res = await runCommitFlow({ baseUrl: BACKEND, bearerToken: sa.token, signer: sa.address, questionId: t.questionId, qid: pre.qid as Hex, nonce: BigInt(pre.nonce ?? "0"), expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300), forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID, solutionBody: canonicalStringify(payload), references: [], token: pre.token.contractAddress as Address, stakeAmount: stake, feeShareBps: pre.feeShareBps ?? 0, feeShares: feeSharesOf(pre), walletClient: wc, privateKey: sa.w.privateKey as Hex });
    await awaitReceipt(pc as any, res.txHash!);
    solByName[name] = res.intentHash;
    ok(`commit ${name} stake=${AMT} USDC (intent ${res.intentHash.slice(0, 12)}…)`);
  }

  await waitSolutionsConfirmed(t.questionId, auths[t.voters[0]].token, t.solvers.length);

  // Votes — winner 80 (or 100 if sole), others split 20.
  for (const voter of t.voters) {
    const va = auths[voter];
    const pre: any = await preflight(t.questionId, "vote", "voter", va.address, va.token);
    const others = t.solvers.filter((s) => s !== t.winner);
    const pts: { name: string; points: number }[] = [{ name: t.winner, points: others.length === 0 ? 100 : 80 }];
    if (others.length > 0) { const share = Math.floor(20 / others.length); let used = 80; others.forEach((o, i) => { const p = i === others.length - 1 ? 100 - used : share; used += p; pts.push({ name: o, points: p }); }); }
    const allocations = pts.map((p) => solByName[p.name] ? { solutionId: solByName[p.name], basisPoints: p.points * 100 } : null).filter((a): a is { solutionId: Hex; basisPoints: number } => !!a);
    const stake = BigInt(pre.stakeAmount);
    const wc = makeWc(va.w);
    await ensureUsdcAllowance(wc, pc as any, { usdc: USDC, forge: FORGE, owner: va.address, required: stake });
    const res = await runVoteFlow({ baseUrl: BACKEND, bearerToken: va.token, signer: va.address, questionId: t.questionId, qid: pre.qid as Hex, nonce: BigInt(pre.nonce ?? "0"), expiresAt: BigInt(pre.voteSaltExpiresAt!), forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID, expectedIntentHash: undefined as unknown as Hex, allocations, voteSalt: pre.voteSalt as Hex, voteSaltToken: pre.voteSaltToken as Hex, token: pre.token.contractAddress as Address, stakeAmount: stake, feeShareBps: pre.feeShareBps ?? 0, feeShares: feeSharesOf(pre), walletClient: wc, privateKey: va.w.privateKey as Hex });
    await awaitReceipt(pc as any, res.txHash!);
    ok(`vote ${voter} stake=${AMT} USDC allocs=${JSON.stringify(pts)}`);
  }
}

async function main() {
  console.log(`rt-resume | backend ${BACKEND} | forge ${FORGE} | chain ${CHAIN_ID}`);
  for (const t of TARGETS) { try { await runTarget(t); } catch (e: any) { console.log(`  ✗ ${t.questionId} crashed: ${e.message?.split("\n")[0]}`); } }
  console.log("\nRT-RESUME DONE");
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
