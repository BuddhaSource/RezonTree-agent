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
}

const SPECS: ScenarioSpec[] = [
  { id: "S0", title: "S0 abandon: sponsor only, zero solutions, full refund zero fee", sponsor: "alice", solvers: [], voters: [], winner: "", abandon: true, referrals: [] },
  { id: "S1", title: "S1 settle: 1 solver (referred) + 2 voters", sponsor: "alice", solvers: ["bob"], voters: ["carol", "dave"], winner: "bob", abandon: false, referrals: [{ referee: "alice", referrer: "grace" }, { referee: "bob", referrer: "grace" }] },
  { id: "S3", title: "S3 settle: 3 solvers (mix referred/un-referred) + 3 voters, top-3", sponsor: "alice", solvers: ["bob", "dave", "heidi"], voters: ["carol", "eve", "frank"], winner: "bob", abandon: false, referrals: [{ referee: "alice", referrer: "grace" }, { referee: "bob", referrer: "grace" }] },
  { id: "S4", title: "S4 settle: 4 solvers, top-3 win, 4th slashed", sponsor: "alice", solvers: ["bob", "dave", "heidi", "ivan"], voters: ["carol", "eve", "frank"], winner: "bob", abandon: false, referrals: [{ referee: "alice", referrer: "grace" }, { referee: "ivan", referrer: "grace" }] },
];

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
  const involved = new Set<string>([spec.sponsor, ...spec.solvers, ...spec.voters, ...spec.referrals.flatMap(r => [r.referee, r.referrer])]);
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
  const qDescription = `Realized-outcome fee-model swarm scenario ${spec.id}. ${spec.title}. `.repeat(12);
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
      const r = await call<{ data?: Array<{ intentHash?: string; intent_hash?: string; confirmationStatus?: string }> }>("GET", `/v1/questions/${questionId}/solutions`, undefined, sponsor.token);
      const confirmed = new Set<string>();
      const list = (r.body?.data ?? []) as any[];
      for (const s of list) {
        const ih = (s.intentHash ?? s.intent_hash ?? "").toString().toLowerCase();
        if (ih && want.has(ih) && (s.confirmationStatus ?? s.confirmation_status) === "confirmed") confirmed.add(ih);
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
  fs.writeFileSync("/tmp/fee-swarm-tally.json", JSON.stringify(out, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  log(`\n=== AGGREGATE ===`);
  log(JSON.stringify(agg, null, 2));
  log(`tally written to /tmp/fee-swarm-tally.json`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
