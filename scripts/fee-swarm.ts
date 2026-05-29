#!/usr/bin/env tsx
// fee-swarm.ts — LIVE 4-layer fee-model swarm (task #662, fee-model B7).
//
// Validates the realized-outcome platform+referral fee model end-to-end
// against a running local stack (anvil chain 31337 + backend + Ponder).
//
// Scenarios (each a full question lifecycle, feeShareBps=10%):
//   S0: sponsor only, 0 solutions  → abandon  → full refund, ZERO fee.
//   S1: 1 solver (with referrer) + 2 voters → settle.
//   S3: 3 solvers (mix referred/un-referred) + voters → settle, top-3 win.
//   S4: 4 solvers, top-3 win, 4th loses (stake slashed) → settle.
//
// Reuses the SDK flow builders (runSponsorFlow / runCommitFlow /
// runVoteFlow / sweepWalletQuestion) + the realized-outcome finance audit
// (reconcileQuestion). Adds the referral leg the battle harness lacks:
// participating contributors set a referrer (POST /v1/me/referrer) so the
// keeper's feeDistributions splits platform/referrer.
//
// Writes /tmp/fee-swarm-tally.json with a per-scenario + aggregate tally
// and the per-recipient accruedFees deltas. Read-only against the chain
// for the audit (it only broadcasts the lifecycle txs, never the audit).

import "dotenv/config";
import fs from "node:fs";
import {
  type Address,
  type Hex,
  createPublicClient,
  http,
} from "viem";

import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { SessionManager } from "../src/wallet/session.js";
import type { AgentWallet } from "../src/wallet/types.js";
import { parseAmountToWei } from "../src/intents/sponsor-intent.js";
import { canonicalStringify } from "../src/intents/commit-intent.js";
import type {
  CommitPreflight,
  FundPreflight,
  VotePreflight,
} from "../src/intents/preflight-types.js";
import {
  awaitReceipt,
  makeAgentWalletClient,
} from "../src/forge/quadphase-broadcast.js";
import {
  ensureUsdcAllowance,
  runCommitFlow,
  runCosponsorFlow,
  runSponsorFlow,
  runVoteFlow,
} from "../src/forge/quadphase-flow.js";
import {
  FORGE_READ_ABI,
  fmtUsdc6,
  readAccruedFees,
  reconcileQuestion,
  type QuestionTrace,
} from "./finance-audit.js";
import { sweepWalletQuestion, type SweepOptions } from "./lib/operator-recovery.js";

// ── Env ──────────────────────────────────────────────────────────
const BACKEND = process.env.RT_BACKEND_URL ?? "http://localhost:8080";
const RPC = process.env.RT_RPC_URL ?? "http://localhost:8545";
const CHAIN_ID = Number.parseInt(process.env.RT_CHAIN_ID ?? "31337", 10);
const USDC = process.env.RT_USDC_ADDRESS as Address;
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const SETTLE_WAIT_MS =
  Number.parseInt(process.env.RT_SETTLE_WAIT_SECONDS ?? "240", 10) * 1000;
const SCENARIOS = (process.env.SWARM_SCENARIOS ?? "S0,S1,S3,S4")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!FORGE || !USDC || !MNEMONIC) throw new Error("RT_FORGE_ADDRESS/RT_USDC_ADDRESS/RT_AGENT_MNEMONIC required");

const publicClient = createPublicClient({ transport: http(RPC) });

const log = (m: string) => console.log(m);
const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
const fail = (m: string) => console.log(`  ✗ ${m}`);

// ── HTTP ─────────────────────────────────────────────────────────
async function call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let parsed: any; try { parsed = txt ? JSON.parse(txt) : {}; } catch { parsed = txt; }
  return { status: res.status, body: parsed };
}

// ── Wallets / auth ───────────────────────────────────────────────
// Pool indices (anvil test-junk): 0=oracle/deployer, 1=platform-fee-recipient.
// Participants drawn from 1-9. We use 1..9 freely; 1 is also the platform
// fee recipient (matches backend FORGE_DEFAULT_PLATFORM_FEE_RECIPIENT).
const POOL: Record<string, number> = {
  oracle: 0, alice: 1, bob: 2, carol: 3, dave: 4, eve: 5, frank: 6, grace: 7, heidi: 8, ivan: 9,
};
const wallets: Record<string, AgentWallet> = {};
for (const [name, idx] of Object.entries(POOL)) wallets[name] = deriveAgentWallet(MNEMONIC, idx, CHAIN_ID);

interface Authed { wallet: AgentWallet; token: string; address: Address }
// P0: one JWT per wallet, reused across every action this run. The
// SessionManager decodes the token's `exp` and only re-logs in within 5 min
// of expiry — with the 15-day access-token TTL that means one login per
// wallet per run. (Replaces the prior inline authCache + per-call login.)
const sessions = new SessionManager({ apiBase: BACKEND, domain: loadLoginDomain() });
async function login(w: AgentWallet): Promise<Authed> {
  const token = await sessions.ensureToken(w);
  return { wallet: w, token, address: w.address as Address };
}

function makeWc(w: AgentWallet) {
  return makeAgentWalletClient({ privateKey: w.privateKey as Hex, chainId: CHAIN_ID, rpcUrl: RPC });
}

async function preflightV2<T>(questionId: string, actionType: string, callerKey: string, caller: Address, token: string): Promise<T> {
  const r = await call<T>("POST", `/v1/questions/${questionId}/intents/preflight?${callerKey}=${caller}`, { actionType, params: { [callerKey]: caller } }, token);
  if ((r as any).status !== 200) throw new Error(`preflight ${actionType} ${questionId} -> ${(r as any).status} ${JSON.stringify((r as any).body)}`);
  return (r as any).body as T;
}

// ── Referral helpers ─────────────────────────────────────────────
const referralCodeOf = new Map<string, string>(); // address -> code

// Round-3 consolidated surface: the standalone /v1/me/referral-code +
// /v1/me/referrer routes are NOT registered in endpoints.go (14-endpoint
// cap). Both fold into PATCH /v1/accounts/me:
//   {referralCode: ""}     → get-or-create the caller's own shareable code
//   {referrer: "<code>"}   → bind who referred the caller (SetReferrer)
async function ensureReferralCode(a: Authed): Promise<string> {
  const have = referralCodeOf.get(a.address.toLowerCase());
  if (have) return have;
  const r = await call<{ referralCode?: { code: string } }>("PATCH", "/v1/accounts/me", { referralCode: "" }, a.token);
  if (r.status !== 200 || !r.body?.referralCode?.code) throw new Error(`claim referral code -> ${r.status} ${JSON.stringify(r.body)}`);
  referralCodeOf.set(a.address.toLowerCase(), r.body.referralCode.code);
  return r.body.referralCode.code;
}

// Bind `referee` to `referrer`'s code (within 24h grace). Reports the
// outcome but never throws on already-set / grace-expired so the swarm
// continues.
async function setReferrer(referee: Authed, referrerCode: string): Promise<string> {
  const r = await call("PATCH", "/v1/accounts/me", { referrer: referrerCode }, referee.token);
  if (r.status === 200 && (r.body as any)?.referrer) return "set";
  return `not-set(${r.status}:${(r.body as any)?.error?.code ?? "?"})`;
}

// ── Solution body ────────────────────────────────────────────────
import { makeSolutionBody } from "../src/testnet/solution-body.js";

function buildSolutionPayload(letter: string, scenarioId: string, criteria: { id: string; name: string }[]) {
  return {
    body: makeSolutionBody(letter, scenarioId),
    reasoningTree: [
      { because: `${letter} analyzed the realized-outcome fee model`, therefore: "fee is skimmed once at settlement, not at action time" },
      { because: "poolAtSettle = sponsor + cosponsor + slashed stakes", therefore: "feeTotal = 10% of poolAtSettle" },
      { because: "a validated referrer earns referralSplitBps of their referee's fee slice", therefore: "platform earns the remainder + dust" },
      { because: "winners recover full stake plus pool share", therefore: "P4 solver-fairness holds at every rank" },
      { because: "losers forfeit stake into the pool", therefore: "P3 anti-slop holds" },
      { because: "abandon/recover refunds everything with zero fee", therefore: "P5 holds" },
    ],
    claims: criteria.map((c) => ({ criterionId: c.id, value: true, argument: `claim against ${c.name}`, falsifiableBy: "audit failure" })),
  };
}

// ── Scenario spec ────────────────────────────────────────────────
interface ScenarioSpec {
  id: string;
  title: string;
  sponsor: string;
  solvers: string[];
  voters: string[];
  winner: string;       // intended top by conviction
  abandon: boolean;     // S0
  // referee->referrer pairings (by pool name); referrer must claim a code.
  referrals: { referee: string; referrer: string }[];
  cosponsor?: string;   // pool name that cosponsors after the sponsor confirms (Q9)
}

const SPECS: ScenarioSpec[] = [
  { id: "S0", title: "S0 abandon: sponsor only, zero solutions, full refund zero fee", sponsor: "alice", solvers: [], voters: [], winner: "", abandon: true, referrals: [] },
  { id: "S1", title: "S1 settle: 1 solver (referred) + 2 voters", sponsor: "alice", solvers: ["bob"], voters: ["carol", "dave"], winner: "bob", abandon: false, referrals: [{ referee: "alice", referrer: "grace" }, { referee: "bob", referrer: "grace" }] },
  { id: "S3", title: "S3 settle: 3 solvers (mix referred/un-referred) + 3 voters, top-3", sponsor: "alice", solvers: ["bob", "dave", "heidi"], voters: ["carol", "eve", "frank"], winner: "bob", abandon: false, referrals: [{ referee: "alice", referrer: "grace" }, { referee: "bob", referrer: "grace" }] },
  { id: "S4", title: "S4 settle: 4 solvers, top-3 win, 4th slashed", sponsor: "alice", solvers: ["bob", "dave", "heidi", "ivan"], voters: ["carol", "eve", "frank"], winner: "bob", abandon: false, referrals: [{ referee: "alice", referrer: "grace" }, { referee: "ivan", referrer: "grace" }] },
  // 10-scenario lifecycle swarm (task #662 follow-up, 2026-05-28). Real
  // academic titles; sponsor=alice everywhere; idx mapping unchanged from
  // POOL above (alice=1..ivan=9 of the bulb-mnemonic). Q4/Q5 abandon via
  // 0-sol DB-only flip. Q6/Q7 reach recover() (driven separately after
  // time-warp). Q8 carries alice->grace referral. Q9 = solo solver (cosponsor
  // leg requires SDK extension — flagged inline).
  { id: "Q1", title: "Methods for accelerating genome decoding in biotech: WGS pipelines under 24h",                              sponsor: "alice", solvers: ["bob"],                  voters: ["carol", "dave"],          winner: "bob", abandon: false, referrals: [] },
  { id: "Q2", title: "Bitcoin trading research: defining a regime-aware momentum strategy for BTC-USD",                            sponsor: "alice", solvers: ["bob", "dave", "heidi"], voters: ["carol", "eve", "frank"],  winner: "bob", abandon: false, referrals: [] },
  { id: "Q3", title: "Best use of GBrain skill by Garry Tan for early-stage YC application review",                                sponsor: "alice", solvers: ["bob", "dave", "heidi", "ivan"], voters: ["carol", "eve", "frank"], winner: "bob", abandon: false, referrals: [] },
  { id: "Q4", title: "LLM evaluation benchmarks beyond static datasets: dynamic agentic eval design",                              sponsor: "alice", solvers: [],                       voters: [],                         winner: "",    abandon: true,  referrals: [] },
  { id: "Q5", title: "Climate modeling: architectures for sub-1km regional downscaling on consumer GPUs",                          sponsor: "alice", solvers: [],                       voters: [],                         winner: "",    abandon: true,  referrals: [] },
  { id: "Q6", title: "AI safety alignment research priorities for frontier-model post-deployment monitoring",                       sponsor: "alice", solvers: [],                       voters: [],                         winner: "",    abandon: false, referrals: [] }, // recover-target: do NOT abandon; time-warp + recover() later
  { id: "Q7", title: "Web3 governance frameworks comparison: liquid democracy vs futarchy vs quadratic",                            sponsor: "alice", solvers: [],                       voters: [],                         winner: "",    abandon: false, referrals: [] }, // recover-target
  { id: "Q8", title: "Solar panel efficiency materials: perovskite stability under tropical conditions",                            sponsor: "alice", solvers: ["bob"],                  voters: ["carol", "dave"],          winner: "bob", abandon: false, referrals: [{ referee: "alice", referrer: "grace" }] },
  { id: "Q9", title: "Distributed systems consensus: Tangle vs DAG vs PBFT for sub-second finality",                                sponsor: "alice", solvers: ["dave"],                 voters: ["carol", "eve"],           winner: "dave", abandon: false, referrals: [], cosponsor: "bob" },
  { id: "Q10", title: "Quantum-safe cryptography: post-NIST round 4 finalist evaluations",                                          sponsor: "alice", solvers: ["bob", "dave", "heidi"], voters: ["carol", "eve", "frank"],  winner: "bob", abandon: false, referrals: [] },
];

// Genuine research framing per question (3-5 sentences). An agent reading
// these later sees plausible questions, not "test N" filler. Keyed by
// spec.id; scenarios without an entry fall back to the generic blurb.
const DESCRIPTIONS: Record<string, string> = {
  Q1: "Whole-genome sequencing pipelines remain the bottleneck for clinical turnaround: secondary analysis (alignment, variant calling, annotation) routinely takes 12-48h per sample on commodity infrastructure. We seek a reproducible architecture that takes a 30x human WGS FASTQ to an annotated, clinically-actionable VCF in under 24 hours end-to-end. Submissions should specify the aligner/caller stack (e.g. DRAGEN vs BWA-MEM2+DeepVariant), the parallelization strategy (per-chromosome sharding, GPU offload), and the hardware envelope. Quantify wall-clock, cost-per-sample, and F1 against GIAB truth sets, and identify which stages dominate the critical path.",
  Q2: "We want a falsifiable specification of a regime-aware momentum strategy for BTC-USD that survives out-of-sample testing across the 2018-2025 cycles. A submission should define the regime classifier (volatility clustering, trend vs mean-reversion detection), the momentum signal and its lookback, position sizing, and transaction-cost assumptions for a realistic venue. Report Sharpe, max drawdown, and turnover on a strict walk-forward split, and explicitly address overfitting and survivorship/look-ahead bias. The strongest answers state the conditions under which the edge decays.",
  Q3: "Garry Tan's 'GBrain' skill encodes a partner-grade heuristic for triaging early-stage YC applications at speed. We seek the highest-leverage workflow for applying it to a batch of 500 applications: how to sequence the founder/market/traction signals, where the skill's judgment is load-bearing versus where it should defer to a human, and how to avoid false negatives on non-obvious outliers. Submissions should propose a concrete review pipeline, a rubric for escalation, and a calibration method against historical YC outcomes. Address the failure mode where pattern-matching penalizes genuinely novel theses.",
  Q4: "Static benchmarks (MMLU, GSM8K) saturate and leak into training data, making them poor signals for frontier agentic capability. We want a design for dynamic, contamination-resistant evaluation: tasks generated or mutated at eval time, graded on multi-step tool-use and recovery from error rather than single-shot answers. Submissions should specify the task-generation mechanism, the grading oracle (programmatic vs model-judge vs human), and how to prevent reward hacking. Quantify how the eval discriminates between models that static benchmarks rate as equivalent.",
  Q5: "Regional climate downscaling to sub-1km resolution is gated by the compute cost of dynamical models, putting it out of reach for most labs. We seek an ML-based downscaling architecture (e.g. diffusion or physics-informed super-resolution) that runs on a single consumer GPU and produces calibrated sub-1km fields from coarse reanalysis input. Submissions should specify the model, the training data and conditioning variables, and the validation against held-out high-resolution observations. Address physical consistency (mass/energy conservation) and quantify the resolution/skill tradeoff versus dynamical downscaling.",
  Q6: "Most alignment effort targets pre-deployment training; far less is invested in detecting capability or behavioral drift after a frontier model ships. We want a prioritized research agenda for post-deployment monitoring: which signals (refusal-rate shifts, jailbreak-success telemetry, distributional shift in tool-calls) are leading indicators of emerging risk, and how to monitor them without unacceptable false-positive load. Submissions should rank interventions by tractability and impact, and propose at least one concrete detector with a measurable success criterion. Identify the monitoring gaps that current evals cannot close.",
  Q7: "Liquid democracy, futarchy, and quadratic voting each promise to fix a different failure of one-token-one-vote on-chain governance. We seek a rigorous comparison across plutocracy resistance, sybil resistance, voter-effort cost, and resistance to vote-buying/bribery markets. Submissions should model each mechanism under a realistic attacker, cite empirical deployments where they exist, and state which mechanism dominates under which assumptions. The strongest answers identify a hybrid or a decisive disqualifying attack rather than declaring a universal winner.",
  Q8: "Perovskite solar cells exceed 25% lab efficiency but degrade rapidly under the heat and humidity of tropical deployment, blocking commercialization where insolation is highest. We seek the most promising materials/encapsulation strategy for maintaining >80% of initial efficiency after 1000h at 85C/85% RH. Submissions should specify the composition (2D/3D mixed-cation, additives), the encapsulation stack, and the degradation pathway being suppressed (ion migration, phase segregation). Report against ISOS damp-heat protocols and quantify the efficiency/stability tradeoff.",
  Q9: "Sub-second deterministic finality is the gating requirement for using a distributed ledger in payments and exchange settlement. We want a head-to-head evaluation of IOTA-style Tangle, generalized DAG-BFT, and classical PBFT across finality latency, throughput, fault tolerance threshold, and behavior under partition. Submissions should state the network/adversary model, cite measured latencies where deployments exist, and identify which design dominates for a sub-second-finality target at hundreds of validators. Address the CAP/cost tradeoffs each makes.",
  Q10: "With NIST's PQC standardization advancing (ML-KEM, ML-DSA standardized; round-4 KEM finalists like Classic McEliece, BIKE, HQC under evaluation), implementers need guidance on the round-4 finalists for niche requirements. We seek a comparative evaluation across security-assumption diversity (code-based vs lattice), key/ciphertext size, constant-time implementation risk, and side-channel surface. Submissions should recommend a finalist for a concrete constrained deployment (e.g. embedded TLS) and justify against the alternatives. Identify the cryptanalytic developments that would change the recommendation.",
};

const SPONSOR_AMOUNT = "1";   // 1 USDC (6dp) per sponsor
const STATUS_SETTLED = 3, STATUS_ABANDONED = 4, STATUS_RECOVERED = 5;

interface ScenarioResult {
  id: string; title: string; questionId: string; qid: string;
  finalStatus: number; outcome: string;
  poolInflowsWei: string; stakesCommittedWei: string;
  winnerClaimsPulledWei: string; stakeRefundsPulledWei: string; stakeRefundsOwedWei: string;
  finalPoolWei: string; feeAccruedWei: string;
  feeRecipientDeltas: { recipient: string; name: string; deltaWei: string }[];
  conserves: boolean; driftWei: string; notes: string[];
  referralsApplied: { referee: string; referrer: string; outcome: string }[];
  errors: string[];
}

const results: ScenarioResult[] = [];

// Track all addresses we want accruedFees deltas for (platform + referrers).
function nameOf(addr: string): string {
  for (const [n, w] of Object.entries(wallets)) if (w.address.toLowerCase() === addr.toLowerCase()) return n;
  return "?";
}

async function runScenario(spec: ScenarioSpec) {
  log(`\n=== ${spec.id}: ${spec.title} ===`);
  const errors: string[] = [];
  const referralsApplied: { referee: string; referrer: string; outcome: string }[] = [];

  // 0) Logins for everyone involved.
  const sponsor = await login(wallets[spec.sponsor]);
  const involved = new Set<string>([spec.sponsor, ...spec.solvers, ...spec.voters, ...spec.referrals.flatMap(r => [r.referee, r.referrer]), ...(spec.cosponsor ? [spec.cosponsor] : [])]);
  const auths: Record<string, Authed> = {};
  for (const name of involved) auths[name] = await login(wallets[name]);

  // 1) Referrals: referrer claims a code, referee binds it (24h grace).
  for (const { referee, referrer } of spec.referrals) {
    try {
      const code = await ensureReferralCode(auths[referrer]);
      const outcome = await setReferrer(auths[referee], code);
      referralsApplied.push({ referee, referrer, outcome });
      ok(`referral ${referee} -> ${referrer} (${code}): ${outcome}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      referralsApplied.push({ referee, referrer, outcome: `error:${msg}` });
      warn(`referral ${referee}->${referrer} failed: ${msg}`);
    }
  }

  // 2) Create question. NOTE the backend's sponsor-preflight builds the
  //    expectedIntentHash from the SponsorWitness using the STORED
  //    question.Title / question.Description, with criteria="" and
  //    tags=[] (preflight.go ~L797). The SDK sponsor witness MUST mirror
  //    those exact values or the intentHash assertion drifts (cross-stack
  //    finding). So we capture the stored title/description and feed them
  //    back into runSponsorFlow with empty criteria + tags.
  const qTitle = spec.title;
  // Genuine per-topic research framing (DESCRIPTIONS map); pad to the
  // backend's MinQuestionDescriptionChars=1000 floor with the scenario
  // tag so the body stays plausible to an agent reading it later.
  const realFraming = DESCRIPTIONS[spec.id] ?? `Realized-outcome fee-model swarm scenario ${spec.id}. ${spec.title}.`;
  let qDescription = realFraming;
  while (qDescription.length < 1050) {
    qDescription += `\n\nSubmissions are scored against the success criteria below; the strongest answer wins by voter conviction. (${spec.id})`;
  }
  const qResp = await call<{ id: string; successCriteria: { id: string; name: string }[] }>("POST", "/v1/questions", {
    title: qTitle,
    description: qDescription,
    successCriteria: [
      { name: "criterion_one", type: "boolean", target: "true", weight: 40 },
      { name: "criterion_two", type: "boolean", target: "true", weight: 35 },
      { name: "criterion_three", type: "boolean", target: "true", weight: 25 },
    ],
    initialBounty: "0",
  }, sponsor.token);
  if (qResp.status !== 201) throw new Error(`create question -> ${qResp.status} ${JSON.stringify(qResp.body)}`);
  const questionId = qResp.body.id;
  const criteria = qResp.body.successCriteria;
  // Fetch the stored title/description verbatim so the sponsor witness
  // mirrors what the backend hashed into expectedIntentHash.
  const qDetail = await call<{ title: string; description: string }>("GET", `/v1/questions/${questionId}`, undefined, sponsor.token);
  const storedTitle = qDetail.body?.title ?? qTitle;
  const storedBody = qDetail.body?.description ?? qDescription;
  ok(`question ${questionId}`);

  // 3) Sponsor fund.
  const sponsorPre = await preflightV2<FundPreflight>(questionId, "sponsor", "sponsor", sponsor.address, sponsor.token);
  if (sponsorPre.mode !== "sponsor") throw new Error(`expected sponsor mode, got ${sponsorPre.mode}`);
  const qid = sponsorPre.qid as Hex;
  const sponsorAmountWei = parseAmountToWei(SPONSOR_AMOUNT, sponsorPre.token.decimals);
  const sponsorWc = makeWc(wallets[spec.sponsor]);
  await ensureUsdcAllowance(sponsorWc, publicClient as any, { usdc: USDC, forge: FORGE, owner: sponsor.address, required: sponsorAmountWei });
  const platformFeeRecipient = (sponsorPre.platformFeeRecipient as Address);
  const settleToken = sponsorPre.token.contractAddress as Address;
  const sponsorResult = await runSponsorFlow({
    baseUrl: BACKEND, bearerToken: sponsor.token, signer: sponsor.address, questionId, qid,
    nonce: BigInt(sponsorPre.nonce ?? "0"),
    expiresAt: BigInt(sponsorPre.recommendedExpiresAt ?? Math.floor(Date.now()/1000)+300),
    forgeAddress: FORGE, chainId: sponsorPre.chainId ?? CHAIN_ID,
    expectedIntentHash: sponsorPre.expectedIntentHash as Hex,
    // Mirror the backend template witness EXACTLY (preflight.go): stored
    // title + description, empty criteria, empty tags. Drift here = the
    // intentHash assertion in runSponsorFlow fails.
    title: storedTitle, body: storedBody, criteria: "", tags: [],
    oracle: (sponsorPre.oracle as Address) ?? wallets.oracle.address as Address,
    sponsorshipFloor: BigInt(sponsorPre.sponsorshipFloor ?? sponsorPre.recommendedSponsorshipFloor ?? "0"),
    commitFee: BigInt(sponsorPre.commitFee ?? "0"), voteFee: BigInt(sponsorPre.voteFee ?? "0"),
    stakeFloor: BigInt(sponsorPre.stakeFloor ?? "0"), stakeBasisPoints: Number(sponsorPre.stakeBasisPoints ?? "0"),
    fundingDeadline: BigInt(sponsorPre.recommendedFundingDeadline ?? Math.floor(Date.now()/1000)+30*86400),
    noSolutionGracePeriod: BigInt(sponsorPre.noSolutionGracePeriod ?? "120"),
    token: settleToken, amount: sponsorAmountWei, feeAmount: 0n,
    feeShareBps: Number(sponsorPre.feeShareBps ?? 0),
    feeShares: [{ recipient: platformFeeRecipient, basisPoints: 10000 }],
    walletClient: sponsorWc, privateKey: wallets[spec.sponsor].privateKey as Hex,
  });
  await awaitReceipt(publicClient as any, sponsorResult.txHash!);
  ok(`sponsor ${SPONSOR_AMOUNT} USDC on-chain (intent ${sponsorResult.intentHash.slice(0,12)}…)`);
  let poolInflows = sponsorAmountWei;

  // Wait for the sponsor to be chain-confirmed + reconciled: the question
  // flips draft→open only after the reconciler projects QuestionSponsored
  // (chain → Ponder finality (~30 blk) → reconciler poll). commit/vote
  // preflight gates on questions.status='open' (R-CHAIN-IS-PUBLIC-TRUTH),
  // so a swarm participant MUST wait here. For S0 (no solvers) we still
  // wait so the abandon grace runs against an open question.
  {
    const openDeadline = Date.now() + 180_000;
    let qstatus = "draft";
    while (qstatus !== "open") {
      const d = await call<{ status: string }>("GET", `/v1/questions/${questionId}`, undefined, sponsor.token);
      qstatus = d.body?.status ?? "?";
      if (qstatus === "open") break;
      if (Date.now() >= openDeadline) { warn(`question still '${qstatus}' after 180s — sponsor not reconciled; aborting scenario lifecycle`); errors.push(`sponsor-not-reconciled status=${qstatus}`); break; }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (qstatus === "open") ok("question open (sponsor reconciled L1→L2→L3)");
  }

  // 3b) Cosponsor (Q9): a second funder adds to the pool after the sponsor
  //     confirmed. Cosponsor inherits q.token / feeShareBps / feeShares from
  //     chain state; the envelope carries only the added amount.
  if (spec.cosponsor) {
    const co = auths[spec.cosponsor];
    const coPre = await preflightV2<FundPreflight>(questionId, "cosponsor", "cosponsor", co.address, co.token);
    const coAmountWei = parseAmountToWei(SPONSOR_AMOUNT, coPre.token.decimals);
    const coWc = makeWc(wallets[spec.cosponsor]);
    await ensureUsdcAllowance(coWc, publicClient as any, { usdc: USDC, forge: FORGE, owner: co.address, required: coAmountWei });
    const coResult = await runCosponsorFlow({
      baseUrl: BACKEND, bearerToken: co.token, signer: co.address, questionId, qid,
      nonce: BigInt(coPre.nonce ?? "0"),
      expiresAt: BigInt(coPre.recommendedExpiresAt ?? Math.floor(Date.now()/1000)+300),
      forgeAddress: FORGE, chainId: coPre.chainId ?? CHAIN_ID,
      expectedIntentHash: coPre.expectedIntentHash as Hex,
      token: (coPre.token.contractAddress as Address),
      amount: coAmountWei, feeAmount: 0n,
      // Cosponsor signs its OWN settlement-skim feeShares (realized-outcome
      // model; chain requires non-empty). Echo the backend-advertised policy
      // verbatim so the locally-built intentHash matches preflight.
      feeShares: (coPre.feeShares ?? []).map((s) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints })),
      feeShareBps: Number(coPre.feeShareBps ?? 0),
      walletClient: coWc, privateKey: wallets[spec.cosponsor].privateKey as Hex,
    });
    await awaitReceipt(publicClient as any, coResult.txHash!);
    poolInflows += coAmountWei;
    ok(`cosponsor ${spec.cosponsor} ${SPONSOR_AMOUNT} USDC on-chain (intent ${coResult.intentHash.slice(0,12)}…)`);
    // Wait for cosponsor reconcile so the pool reflects it before commits.
    await new Promise((r) => setTimeout(r, 12000));
  }

  // Snapshot platform accrued BEFORE settle (global mapping; isolate this Q).
  const accruedBefore = new Map<string, bigint>();
  const trackRecipients = new Set<string>([platformFeeRecipient.toLowerCase()]);
  for (const { referrer } of spec.referrals) trackRecipients.add(wallets[referrer].address.toLowerCase());
  for (const addr of trackRecipients) {
    accruedBefore.set(addr, await readAccruedFees({ publicClient: publicClient as any, forge: FORGE, recipient: addr as Address, token: settleToken }));
  }

  // 4) Solvers commit.
  const solutionsByLetter: Record<string, { id: string; intentHash: Hex; stake: bigint; submitter: Authed }> = {};
  let stakesCommitted = 0n;
  for (const solverName of spec.solvers) {
    const sa = auths[solverName];
    const pre = await preflightV2<CommitPreflight>(questionId, "commit", "submitter", sa.address, sa.token);
    // FINDING (HIGH cross-layer drift): the deployed contract's realized-
    // outcome shape gate (QuadphaseShapes.sol) reverts
    // `commit:feeAmount-must-be-zero` for ANY non-zero commit feeAmount,
    // but the backend commit preflight advertises feeAmount=chain_commit_fee
    // (10000 here). Following preflight verbatim guarantees a chain revert.
    // The realized-outcome model takes the fee ONCE at settlement, so the
    // correct commit feeAmount is 0. We force 0 to match the chain.
    const preFee = BigInt(pre.feeAmount);
    if (preFee !== 0n) { warn(`commit preflight advertised feeAmount=${preFee} but chain requires 0 (realized-outcome) — forcing 0 [FINDING]`); errors.push(`commit-preflight-fee-nonzero:${preFee}`); }
    const fee = 0n; const stake = BigInt(pre.stakeAmount);
    const wc = makeWc(wallets[solverName]);
    await ensureUsdcAllowance(wc, publicClient as any, { usdc: USDC, forge: FORGE, owner: sa.address, required: fee + stake });
    const payload = buildSolutionPayload(solverName, spec.id, criteria);
    const feeShares = (pre.feeShares && pre.feeShares.length > 0)
      ? pre.feeShares.map((s: any) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
      : [{ recipient: platformFeeRecipient, basisPoints: 10000 }];
    const result = await runCommitFlow({
      baseUrl: BACKEND, bearerToken: sa.token, signer: sa.address, questionId, qid,
      nonce: BigInt(pre.nonce ?? "0"),
      expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now()/1000)+300),
      forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID,
      solutionBody: canonicalStringify(payload), references: [],
      token: pre.token.contractAddress as Address, feeAmount: fee, stakeAmount: stake,
      feeShareBps: pre.feeShareBps ?? 0, feeShares,
      walletClient: wc, privateKey: wallets[solverName].privateKey as Hex,
    });
    await awaitReceipt(publicClient as any, result.txHash!);
    solutionsByLetter[solverName] = { id: result.intentHash, intentHash: result.intentHash, stake, submitter: sa };
    poolInflows += fee; stakesCommitted += stake;
    ok(`commit ${solverName} stake=${fmtUsdc6(stake)} fee=${fmtUsdc6(fee)} intent=${result.intentHash.slice(0,12)}…`);
  }

  // Wait for ALL commits to be ponder→reconciler confirmed. R-CHAIN-IS-
  // PUBLIC-TRUTH: votes can only allocate to confirmed solutions, so we
  // must block until each committed intent_hash appears confirmed at
  // the public list endpoint. [SWARM FIX]
  if (spec.solvers.length > 0) {
    const commitWaitDeadline = Date.now() + 180_000;
    const want = new Set(spec.solvers.map((s) => solutionsByLetter[s].intentHash.toLowerCase()));
    while (Date.now() < commitWaitDeadline) {
      // Round-3 consolidated surface: the standalone /v1/questions/:id/solutions
      // route is gone (ROUTE_NOT_FOUND). Solutions embed under the question
      // detail via ?include=solutions → { solutions: { data: [...] } }. [SWARM FIX #629]
      const r = await call<{ solutions?: { data?: any[] } }>("GET", `/v1/questions/${questionId}?include=solutions`, undefined, sponsor.token);
      const confirmed = new Set<string>();
      const list = (r.body?.solutions?.data ?? []) as any[];
      for (const s of list) {
        const ih = (s.intentHash ?? s.intent_hash ?? "").toString().toLowerCase();
        // The ?include=solutions embed is confirmed-only (R-CHAIN-IS-PUBLIC-TRUTH):
        // a row's mere PRESENCE means it's chain-confirmed. The embed does not
        // carry confirmationStatus, so presence is the signal. [SWARM FIX #629]
        if (ih && want.has(ih)) confirmed.add(ih);
      }
      if (confirmed.size === want.size) { ok(`all ${want.size} commits confirmed (chain→Ponder→DB)`); break; }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // 5) Voters cast — winner gets 80%, others split 20%; if 4 solvers the
  //    4th (last) gets 0 so it loses + slashes.
  let voteStakes = 0n;
  for (const voterName of spec.voters) {
    const va = auths[voterName];
    const pre = await preflightV2<VotePreflight>(questionId, "vote", "voter", va.address, va.token);
    // Build point allocations across the WINNING set (top-3). For S4 leave ivan (4th) at 0.
    const winners = spec.solvers.filter((s) => s !== spec.solvers[3]); // drop 4th if present
    const pointAllocs: { letter: string; points: number }[] = [];
    const others = winners.filter((l) => l !== spec.winner);
    pointAllocs.push({ letter: spec.winner, points: others.length === 0 ? 100 : 80 });
    if (others.length > 0) {
      const share = Math.floor(20 / others.length); let assigned = 80;
      for (let i = 0; i < others.length; i++) { const pts = i === others.length-1 ? 100-assigned : share; assigned += pts; pointAllocs.push({ letter: others[i], points: pts }); }
    }
    const allocations = pointAllocs.map((pa) => { const sol = solutionsByLetter[pa.letter]; return sol ? { solutionId: sol.intentHash, basisPoints: pa.points*100 } : null; }).filter((a): a is { solutionId: Hex; basisPoints: number } => a !== null);
    if (!pre.voteSalt || !pre.voteSaltToken) throw new Error("vote preflight missing voteSalt");
    // Same realized-outcome shape gate as commit: vote:feeAmount-must-be-zero.
    const preFeeV = BigInt(pre.feeAmount);
    if (preFeeV !== 0n) { warn(`vote preflight advertised feeAmount=${preFeeV} but chain requires 0 (realized-outcome) — forcing 0 [FINDING]`); errors.push(`vote-preflight-fee-nonzero:${preFeeV}`); }
    const fee = 0n; const stake = BigInt(pre.stakeAmount);
    const wc = makeWc(wallets[voterName]);
    await ensureUsdcAllowance(wc, publicClient as any, { usdc: USDC, forge: FORGE, owner: va.address, required: fee + stake });
    const feeShares = (pre.feeShares && pre.feeShares.length > 0)
      ? pre.feeShares.map((s: any) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
      : [{ recipient: platformFeeRecipient, basisPoints: 10000 }];
    const result = await runVoteFlow({
      baseUrl: BACKEND, bearerToken: va.token, signer: va.address, questionId, qid,
      nonce: BigInt(pre.nonce ?? "0"), expiresAt: BigInt(pre.voteSaltExpiresAt!),
      forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID,
      // Vote preflight returns expectedIntentHash built from an EMPTY-
      // allocations placeholder (preflight.go ~L1240). The real envelope
      // uses actual allocations, so the local recompute MUST diverge.
      // Per runVoteFlow comment (quadphase-flow.ts ~L702): callers pass
      // undefined here and the assertion no-ops. Backend re-derives at
      // Stage 2 from the submitted payload. [SWARM FIX]
      expectedIntentHash: undefined as unknown as Hex, allocations,
      voteSalt: pre.voteSalt as Hex, voteSaltToken: pre.voteSaltToken as Hex,
      token: pre.token.contractAddress as Address, feeAmount: fee, stakeAmount: stake,
      feeShareBps: pre.feeShareBps ?? 0, feeShares,
      walletClient: wc, privateKey: wallets[voterName].privateKey as Hex,
    });
    await awaitReceipt(publicClient as any, result.txHash!);
    poolInflows += fee; voteStakes += stake;
    ok(`vote ${voterName} stake=${fmtUsdc6(stake)} fee=${fmtUsdc6(fee)} allocs=${JSON.stringify(pointAllocs)}`);
  }

  // 6) Wait for terminal status. Two terminal signals:
  //   - chain getQuestionScalars status 3/4/5 (settle via keeper, or an
  //     on-chain AbandonWitness broadcast), OR
  //   - DB status='abandoned' for the NO-SOLUTION abandon, which is
  //     operator-driven (River SettleRound→abandon): the chain has no
  //     incentive to auto-abandon so it stays Open(1); refunds pull via
  //     sponsorRefund/expiredRefund once the DB flips (me.go gates on
  //     questions.status='abandoned'). So we accept the DB signal too.
  let status = await readStatus(qid);
  let dbStatus = "open";
  const deadline = Date.now() + SETTLE_WAIT_MS;
  if (spec.abandon) {
    log(`  S0: waiting for round deadline + lifecycle-scan abandon (chain stays Open for no-solution; DB flips to abandoned)…`);
  }
  while (status !== STATUS_SETTLED && status !== STATUS_ABANDONED && status !== STATUS_RECOVERED && dbStatus !== "abandoned") {
    if (Date.now() >= deadline) { warn(`terminal status not reached within ${SETTLE_WAIT_MS/1000}s (chain=${status} db=${dbStatus})`); break; }
    await new Promise((r) => setTimeout(r, 8000));
    status = await readStatus(qid);
    const d = await call<{ status: string }>("GET", `/v1/questions/${questionId}`, undefined, sponsor.token);
    dbStatus = d.body?.status ?? dbStatus;
  }
  if (status === STATUS_SETTLED) ok("settled (keeper-published)");
  else if (status === STATUS_ABANDONED) ok("abandoned (chain)");
  else if (status === STATUS_RECOVERED) ok("recovered");
  else if (dbStatus === "abandoned") ok("abandoned (DB; chain stays Open — no-solution operator abandon)");

  // 7) Money-out sweep (claims + refunds) for all participants + sponsor.
  let winnerClaimsPulled = 0n, stakeRefundsPulled = 0n, stakeRefundsOwed = 0n;
  // Also sweep on DB-only abandonment (operator path for no-solution Qs):
  // chain stays Open(1) but DB flips abandoned, and the unified withdraw
  // door (/v1/me/...) authorizes a sponsor refund. [SWARM FIX]
  if (status === STATUS_SETTLED || status === STATUS_ABANDONED || status === STATUS_RECOVERED || dbStatus === "abandoned") {
    const sweepOpts: SweepOptions = { apiBase: BACKEND, forgeAddress: FORGE, rpcUrl: RPC, chainId: CHAIN_ID, dryRun: false };
    const participants = new Set<string>([spec.sponsor, ...spec.solvers, ...spec.voters]);
    for (const name of participants) {
      try {
        const a = auths[name];
        const r = await sweepWalletQuestion(sweepOpts, { index: POOL[name], address: wallets[name].address as Address, privateKey: wallets[name].privateKey as Hex }, a.token, questionId);
        for (const item of r.items) {
          if (item.actionType === "claim") { if (item.status === "broadcast") winnerClaimsPulled += item.amountWei; }
          else { stakeRefundsOwed += item.owedWei; if (item.status === "broadcast") stakeRefundsPulled += item.amountWei; }
        }
        if (r.items.length) ok(`sweep ${name}: ${r.items.map(i => `${i.actionType}:${fmtUsdc6(i.amountWei)}(${i.status})`).join(", ")}`);
      } catch (e) { const m = e instanceof Error ? e.message.split("\n")[0] : String(e); warn(`sweep ${name} failed: ${m}`); errors.push(`sweep ${name}: ${m}`); }
    }
  }

  // 8) Read final chain state + accrued deltas.
  const finalStatus = await readStatus(qid);
  const finalPool = await readPool(qid);
  const feeRecipientDeltas: { recipient: string; name: string; deltaWei: string }[] = [];
  let feeAccrued = 0n;
  for (const addr of trackRecipients) {
    const after = await readAccruedFees({ publicClient: publicClient as any, forge: FORGE, recipient: addr as Address, token: settleToken });
    const delta = after - (accruedBefore.get(addr) ?? 0n);
    feeRecipientDeltas.push({ recipient: addr, name: nameOf(addr), deltaWei: delta.toString() });
    feeAccrued += delta;
  }

  const outcome = finalStatus === STATUS_ABANDONED ? "abandoned" : finalStatus === STATUS_RECOVERED ? "recovered" : "settled";
  const escrowRemaining = stakeRefundsOwed - stakeRefundsPulled;
  const trace: QuestionTrace = {
    scenarioId: spec.id, qid, outcome: outcome as any,
    poolInflowsWei: poolInflows, stakesCommittedWei: stakesCommitted + voteStakes,
    winnerClaimsPulledWei: winnerClaimsPulled, stakeRefundsPulledWei: stakeRefundsPulled,
    feeAccruedWei: feeAccrued,
  };
  const audit = reconcileQuestion(trace, finalPool, escrowRemaining);
  if (audit.conserves) ok(`conserves ✓ (drift 0, fee accrued ${fmtUsdc6(feeAccrued)})`);
  else fail(`drift ${audit.drift.toString()} wei — ${audit.notes.join("; ")}`);

  results.push({
    id: spec.id, title: spec.title, questionId, qid, finalStatus, outcome,
    poolInflowsWei: poolInflows.toString(), stakesCommittedWei: (stakesCommitted+voteStakes).toString(),
    winnerClaimsPulledWei: winnerClaimsPulled.toString(), stakeRefundsPulledWei: stakeRefundsPulled.toString(),
    stakeRefundsOwedWei: stakeRefundsOwed.toString(), finalPoolWei: finalPool.toString(), feeAccruedWei: feeAccrued.toString(),
    feeRecipientDeltas, conserves: audit.conserves, driftWei: audit.drift.toString(), notes: audit.notes,
    referralsApplied, errors,
  });
}

async function readStatus(qid: Hex): Promise<number> {
  const s = (await publicClient.readContract({ address: FORGE, abi: FORGE_READ_ABI, functionName: "getQuestionScalars", args: [qid] })) as readonly [Address, number, bigint, boolean];
  return Number(s[1]);
}
async function readPool(qid: Hex): Promise<bigint> {
  const s = (await publicClient.readContract({ address: FORGE, abi: FORGE_READ_ABI, functionName: "getQuestionScalars", args: [qid] })) as readonly [Address, number, bigint, boolean];
  return s[2];
}

async function main() {
  log(`fee-swarm | backend ${BACKEND} | forge ${FORGE} | chain ${CHAIN_ID} | scenarios ${SCENARIOS.join(",")}`);
  for (const spec of SPECS) {
    if (!SCENARIOS.includes(spec.id)) continue;
    try { await runScenario(spec); }
    catch (e) { const m = e instanceof Error ? e.message : String(e); fail(`${spec.id} crashed: ${m}`); results.push({ id: spec.id, title: spec.title, questionId: "", qid: "", finalStatus: -1, outcome: "crashed", poolInflowsWei: "0", stakesCommittedWei: "0", winnerClaimsPulledWei: "0", stakeRefundsPulledWei: "0", stakeRefundsOwedWei: "0", finalPoolWei: "0", feeAccruedWei: "0", feeRecipientDeltas: [], conserves: false, driftWei: "0", notes: [m], referralsApplied: [], errors: [m] }); }
  }
  // Aggregate.
  const agg = {
    scenarios: results.length,
    allConserve: results.every((r) => r.conserves),
    totalFeeAccruedWei: results.reduce((s, r) => s + BigInt(r.feeAccruedWei), 0n).toString(),
    totalPoolInflowsWei: results.reduce((s, r) => s + BigInt(r.poolInflowsWei), 0n).toString(),
    totalStakesCommittedWei: results.reduce((s, r) => s + BigInt(r.stakesCommittedWei), 0n).toString(),
  };
  const out = { startedAt: new Date().toISOString(), chainId: CHAIN_ID, forge: FORGE, token: USDC, results, aggregate: agg };
  const tallyPath = process.env.SWARM_TALLY_PATH ?? "/tmp/fee-swarm-tally.json";
  fs.writeFileSync(tallyPath, JSON.stringify(out, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  log(`\n=== AGGREGATE ===`);
  log(JSON.stringify(agg, null, 2));
  log(`tally written to ${tallyPath}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
