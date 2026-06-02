#!/usr/bin/env tsx
// organic-swarm.ts — autonomous, independent agents that DISCOVER platform
// state and DECIDE what to do, rather than walking a fixed scenario script.
//
// Each agent runs its own concurrent loop:
//     discover (GET /v1/questions?status=open)
//   → decide   (weighted policy over candidate sets + own history)
//   → act      (ask / solve / vote / cosponsor)  → sleep(random)
//
// Emergent interleaving across N concurrent agents stresses the
// backend / chain / reconciler under realistic organic load — the kind
// of races a scripted scenario walker (fee-swarm.ts, run-battle.ts)
// can't produce. The keeper auto-settles each round at its deadline in
// the background, so winners/claims emerge organically too.
//
// Reuses the proven SDK flows (runSponsorFlow / runCommitFlow /
// runVoteFlow / runCosponsorFlow) + the same auth/derivation path
// fee-swarm.ts exercises end-to-end.
//
// Usage:
//   set -a; source .env; set +a
//   ORGANIC_DURATION_SECONDS=1800 \
//     node_modules/.bin/tsx scripts/organic-swarm.ts
//
// Self-action rules (R-NOT-SELF-SUBMIT / R-NOT-SELF-VOTE /
// R-NOT-COSPONSOR-SOLVER) are respected when picking candidates so the
// log stays signal-rich; the backend enforces them regardless.

import "dotenv/config";
import { createPublicClient, http, type Address, type Hex } from "viem";

import { deriveAgentWallet } from "../src/wallet/derive.js";
import { sessionManagerFor } from "../src/wallet/login.js";
import type { AgentWallet } from "../src/wallet/types.js";
import { resolveSpecialization, type Persona } from "../src/personas/registry.js";
import { assignPersonas, type Blend } from "../src/bootstrap/onboard.js";
import { resolveDeadlineMs, buildActionMenu } from "../src/swarm/policy.js";
import { parseAmountToWei } from "../src/intents/amounts.js";
import { canonicalStringify } from "../src/intents/commit-intent.js";
import type {
  FundPreflight,
  CommitPreflight,
  VotePreflight,
} from "../src/intents/preflight-types.js";
import { awaitReceipt, makeAgentWalletClient } from "../src/forge/quadphase-broadcast.js";
import {
  ensureUsdcAllowance,
  runSponsorFlow,
  runCommitFlow,
  runVoteFlow,
  runCosponsorFlow,
} from "../src/forge/quadphase-flow.js";
import { makeSolutionBody } from "../src/testnet/solution-body.js";
import { broadcastErrorMessage, isInsufficientFunds } from "../src/testnet/broadcast-error.js";

// ── Env ──────────────────────────────────────────────────────────
const BACKEND = process.env.RT_BACKEND_URL ?? "http://localhost:8080";
const RPC = process.env.RT_RPC_URL ?? "http://localhost:8545";
const CHAIN_ID = Number.parseInt(process.env.RT_CHAIN_ID ?? "31337", 10);
const USDC = process.env.RT_USDC_ADDRESS as Address;
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
// ORGANIC_DURATION_SECONDS=0 (or negative) ⇒ run forever — continuous mode.
const DURATION_SEC = Number.parseInt(process.env.ORGANIC_DURATION_SECONDS ?? "1800", 10);
const AGENT_NAMES = (process.env.ORGANIC_AGENTS ?? "alice,bob,carol,dave,eve,frank,grace,heidi,ivan")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SPONSOR_AMOUNT = process.env.ORGANIC_SPONSOR_AMOUNT ?? "1";
const TICK_MIN_MS = Number.parseInt(process.env.ORGANIC_TICK_MIN_MS ?? "3000", 10);
const TICK_MAX_MS = Number.parseInt(process.env.ORGANIC_TICK_MAX_MS ?? "9000", 10);
// Cap how many questions any one agent sponsors over the whole run, so a 7-agent
// swarm with little to do can't flood the board (each ask sponsors real USDC).
// The natural-run failure was every idle agent picking "ask" → over-production
// far beyond the funding budget. A per-agent ceiling bounds production directly.
const MAX_ASKS_PER_AGENT = Number.parseInt(process.env.ORGANIC_MAX_ASKS_PER_AGENT ?? "3", 10);
// Keep the board warm: when fewer than this many questions are open, agents
// refill it even past their per-agent ask cap, so a forever-run never drains.
const WARM_FLOOR = Number.parseInt(process.env.ORGANIC_WARM_FLOOR ?? "3", 10);
// Persona blend across the team — sets each agent's action-weight profile
// (researcher posts, solver solves, voter votes). Set by `rt init`.
const BLEND = (process.env.ORGANIC_BLEND ?? "balanced") as Blend;

if (!FORGE || !USDC || !MNEMONIC) throw new Error("RT_FORGE_ADDRESS/RT_USDC_ADDRESS/RT_AGENT_MNEMONIC required");

const publicClient = createPublicClient({ transport: http(RPC) });
const POOL: Record<string, number> = {
  oracle: 0, alice: 1, bob: 2, carol: 3, dave: 4, eve: 5, frank: 6, grace: 7, heidi: 8, ivan: 9,
};

// ── Utils ────────────────────────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 19);
const log = (name: string, m: string) => console.log(`${ts()} [${name.padEnd(6)}] ${m}`);
const rand = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

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

const makeWc = (w: AgentWallet) => makeAgentWalletClient({ privateKey: w.privateKey as Hex, chainId: CHAIN_ID, rpcUrl: RPC });

async function preflightV2<T>(qid: string, actionType: string, callerKey: string, caller: Address, token: string): Promise<T> {
  const r = await call<T>("POST", `/v1/questions/${qid}/intents/preflight?${callerKey}=${caller}`, { actionType, params: { [callerKey]: caller } }, token);
  if ((r as any).status !== 200) throw new Error(`preflight ${actionType} ${qid} -> ${(r as any).status} ${JSON.stringify((r as any).body).slice(0, 200)}`);
  return (r as any).body as T;
}

// ── Content pool — topics + framing come from the specialization registry,
// set by `rt init` via RT_SPECIALIZATION / RT_TOPICS (no hardcoded list). The
// specialization's quality lens is baked into each framing so every question
// pushes solvers toward precise, falsifiable, trainable answers.
const SPEC = resolveSpecialization(process.env.RT_SPECIALIZATION);
const TOPIC_TITLES = process.env.RT_TOPICS
  ? process.env.RT_TOPICS.split("|").map((t) => t.trim()).filter(Boolean)
  : SPEC.topicSeeds;
const TOPICS: { title: string; framing: string }[] = TOPIC_TITLES.map((title) => ({
  title,
  framing: `${title}. Solve with rigor — ${SPEC.qualityLens}`,
}));
if (TOPICS.length === 0) {
  // Fail fast instead of silently swallowing every "ask" at runtime: an empty
  // RT_TOPICS (e.g. "|") or a seedless specialization would leave nothing to post.
  throw new Error(
    "No topics resolved — set RT_TOPICS (| separated) or RT_SPECIALIZATION to a domain with topic seeds (rt init emits both).",
  );
}

function makeDescription(framing: string, tag: string): string {
  let d = framing;
  while (d.length < 1050) {
    d += `\n\nSubmissions are scored against the success criteria below; the strongest answer wins by voter conviction. Address the stated model, cite evidence where it exists, and identify the gaps current approaches cannot close. (${tag})`;
  }
  return d;
}

// ── Agent state ──────────────────────────────────────────────────
interface Agent {
  name: string;
  persona: Persona; // role + action-weight profile (researcher/solver/voter/…)
  wallet: AgentWallet;
  address: Address;
  token: string;
  sponsored: Set<string>;
  solved: Set<string>;
  voted: Set<string>;
  cosponsored: Set<string>;
  acts: Record<string, number>; // action -> count
  broke: boolean; // true once a funded action reverted on insufficient funds — pause funded actions
}

interface OpenQ { id: string; author: string; title: string }

const sessions = sessionManagerFor(BACKEND);

// ── Discovery ────────────────────────────────────────────────────
async function listOpenQuestions(token: string): Promise<OpenQ[]> {
  const r = await call<{ data?: any[] }>("GET", `/v1/questions?status=open`, undefined, token);
  const data = (r.body?.data ?? []) as any[];
  return data.map((q) => ({ id: q.id, author: (q.authorAddress ?? "").toLowerCase(), title: q.title ?? "" }));
}

async function confirmedSolutions(qid: string, token: string): Promise<{ intentHash: Hex; author: string }[]> {
  const r = await call<{ solutions?: { data?: any[] } }>("GET", `/v1/questions/${qid}?include=solutions`, undefined, token);
  const list = (r.body?.solutions?.data ?? []) as any[];
  return list
    .map((s) => ({ intentHash: (s.intentHash ?? s.intent_hash ?? "").toString() as Hex, author: (s.authorAddress ?? "").toLowerCase() }))
    .filter((s) => s.intentHash.startsWith("0x"));
}

// ── Actions ──────────────────────────────────────────────────────
async function actAsk(a: Agent): Promise<void> {
  const topic = pick(TOPICS);
  const tag = `${a.name}-${Date.now().toString(36)}`;
  const qResp = await call<{ id: string; successCriteria: { id: string; name: string }[] }>("POST", "/v1/questions", {
    title: topic.title,
    description: makeDescription(topic.framing, tag),
    successCriteria: [
      { name: "criterion_one", type: "boolean", target: "true", weight: 40 },
      { name: "criterion_two", type: "boolean", target: "true", weight: 35 },
      { name: "criterion_three", type: "boolean", target: "true", weight: 25 },
    ],
    initialBounty: process.env.RT_INITIAL_BOUNTY ?? "1000000",
  }, a.token);
  if (qResp.status !== 201) throw new Error(`create question -> ${qResp.status} ${JSON.stringify(qResp.body).slice(0, 160)}`);
  const questionId = qResp.body.id;
  const qDetail = await call<{ title: string; description: string }>("GET", `/v1/questions/${questionId}`, undefined, a.token);

  const pre = await preflightV2<FundPreflight>(questionId, "sponsor", "sponsor", a.address, a.token);
  const qid = pre.qid as Hex;
  const amount = parseAmountToWei(SPONSOR_AMOUNT, pre.token.decimals);
  const wc = makeWc(a.wallet);
  await ensureUsdcAllowance(wc, publicClient as any, { usdc: USDC, forge: FORGE, owner: a.address, required: amount });
  const r = await runSponsorFlow({
    baseUrl: BACKEND, bearerToken: a.token, signer: a.address, questionId, qid,
    nonce: BigInt(pre.nonce ?? "0"),
    expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
    forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID,
    expectedIntentHash: pre.expectedIntentHash as Hex,
    title: qDetail.body?.title ?? topic.title, body: qDetail.body?.description ?? "", criteria: "", tags: [],
    oracle: (pre.oracle as Address),
    sponsorshipFloor: BigInt(pre.sponsorshipFloor ?? pre.recommendedSponsorshipFloor ?? "0"),
    commitFee: BigInt(pre.commitFee ?? "0"), voteFee: BigInt(pre.voteFee ?? "0"),
    stakeFloor: BigInt(pre.stakeFloor ?? "0"), stakeBasisPoints: Number(pre.stakeBasisPoints ?? "0"),
    fundingDeadline: BigInt(pre.recommendedFundingDeadline ?? Math.floor(Date.now() / 1000) + 30 * 86400),
    noSolutionGracePeriod: BigInt(pre.noSolutionGracePeriod ?? "120"),
    token: pre.token.contractAddress as Address, amount, feeAmount: 0n,
    feeShareBps: Number(pre.feeShareBps ?? 0),
    feeShares: [{ recipient: pre.platformFeeRecipient as Address, basisPoints: 10000 }],
    walletClient: wc, privateKey: a.wallet.privateKey as Hex,
  });
  await awaitReceipt(publicClient as any, r.txHash!);
  a.sponsored.add(questionId);
  log(a.name, `ASK   "${topic.title.slice(0, 38)}" → ${questionId} (sponsored ${SPONSOR_AMOUNT} USDC)`);
}

async function actSolve(a: Agent, q: OpenQ): Promise<void> {
  // Claims must reference the question's REAL success-criterion IDs (FK on
  // claims.criterion_id); a bogus id FK-violates → 500. Fetch them.
  const detail = await call<{ successCriteria?: { id: string; name: string }[] }>("GET", `/v1/questions/${q.id}`, undefined, a.token);
  const criteria = detail.body?.successCriteria ?? [];
  const pre = await preflightV2<CommitPreflight>(q.id, "commit", "submitter", a.address, a.token);
  const stake = BigInt(pre.stakeAmount);
  const wc = makeWc(a.wallet);
  await ensureUsdcAllowance(wc, publicClient as any, { usdc: USDC, forge: FORGE, owner: a.address, required: stake });
  // Backend requires 6-25 reasoningTree nodes, each {because, therefore, confidence}.
  const payload = {
    body: makeSolutionBody(a.name, q.id),
    reasoningTree: [
      { because: `${a.name} parsed the question's success criteria`, therefore: "each criterion gets a falsifiable claim", confidence: 0.9 },
      { because: "the strongest answer wins by voter conviction", therefore: "the argument is structured for adversarial review", confidence: 0.8 },
      { because: "the realized-outcome fee model skims once at settlement", therefore: "no per-action fee distorts the incentive to submit quality", confidence: 0.85 },
      { because: "losers forfeit their full stake into the pool", therefore: "low-effort submissions are priced out (anti-slop)", confidence: 0.8 },
      { because: "winners recover stake plus a conviction-weighted pool share", therefore: "effort is rewarded proportionally to peer-judged quality", confidence: 0.75 },
      { because: "the claim is grounded in cited, checkable evidence", therefore: "a skeptical voter can verify rather than trust", confidence: 0.7 },
    ],
    claims: criteria.map((c) => ({ criterionId: c.id, value: true, argument: `${a.name}: evidence-backed claim against ${c.name}`, falsifiableBy: "audit failure" })),
  };
  const feeShares = (pre.feeShares && pre.feeShares.length > 0)
    ? pre.feeShares.map((s: any) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
    : [{ recipient: pre.platformFeeRecipient as Address, basisPoints: 10000 }];
  const r = await runCommitFlow({
    baseUrl: BACKEND, bearerToken: a.token, signer: a.address, questionId: q.id, qid: pre.qid as Hex,
    nonce: BigInt(pre.nonce ?? "0"),
    expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
    forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID,
    solutionBody: canonicalStringify(payload), references: [],
    token: pre.token.contractAddress as Address, stakeAmount: stake,
    feeShareBps: pre.feeShareBps ?? 0, feeShares,
    walletClient: wc, privateKey: a.wallet.privateKey as Hex,
  });
  await awaitReceipt(publicClient as any, r.txHash!);
  a.solved.add(q.id);
  log(a.name, `SOLVE ${q.id} stake=${SPONSOR_AMOUNT} USDC "${q.title.slice(0, 32)}"`);
}

async function actVote(a: Agent, q: OpenQ, sols: { intentHash: Hex; author: string }[]): Promise<void> {
  // Allocate conviction across up to 3 solutions NOT authored by this agent.
  const candidates = sols.filter((s) => s.author !== a.address.toLowerCase()).slice(0, 3);
  if (candidates.length === 0) throw new Error("no votable solutions (all self-authored)");
  // Random favored split summing to 10000 bps.
  const weights = candidates.map(() => rand(1, 10));
  const total = weights.reduce((x, y) => x + y, 0);
  let assigned = 0;
  const allocations = candidates.map((s, i) => {
    const bps = i === candidates.length - 1 ? 10000 - assigned : Math.floor((weights[i] / total) * 10000);
    assigned += bps;
    return { solutionId: s.intentHash, basisPoints: bps };
  });
  const pre = await preflightV2<VotePreflight>(q.id, "vote", "voter", a.address, a.token);
  if (!pre.voteSalt || !pre.voteSaltToken) throw new Error("vote preflight missing voteSalt");
  const stake = BigInt(pre.stakeAmount);
  const wc = makeWc(a.wallet);
  await ensureUsdcAllowance(wc, publicClient as any, { usdc: USDC, forge: FORGE, owner: a.address, required: stake });
  const feeShares = (pre.feeShares && pre.feeShares.length > 0)
    ? pre.feeShares.map((s: any) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
    : [{ recipient: pre.platformFeeRecipient as Address, basisPoints: 10000 }];
  const r = await runVoteFlow({
    baseUrl: BACKEND, bearerToken: a.token, signer: a.address, questionId: q.id, qid: pre.qid as Hex,
    nonce: BigInt(pre.nonce ?? "0"), expiresAt: BigInt(pre.voteSaltExpiresAt!),
    forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID,
    expectedIntentHash: undefined as unknown as Hex, allocations,
    voteSalt: pre.voteSalt as Hex, voteSaltToken: pre.voteSaltToken as Hex,
    token: pre.token.contractAddress as Address, stakeAmount: stake,
    feeShareBps: pre.feeShareBps ?? 0, feeShares,
    walletClient: wc, privateKey: a.wallet.privateKey as Hex,
  });
  await awaitReceipt(publicClient as any, r.txHash!);
  a.voted.add(q.id);
  log(a.name, `VOTE  ${q.id} across ${allocations.length} sol(s) stake=${SPONSOR_AMOUNT} USDC`);
}

async function actCosponsor(a: Agent, q: OpenQ): Promise<void> {
  const pre = await preflightV2<FundPreflight>(q.id, "cosponsor", "cosponsor", a.address, a.token);
  const amount = parseAmountToWei(SPONSOR_AMOUNT, pre.token.decimals);
  const wc = makeWc(a.wallet);
  await ensureUsdcAllowance(wc, publicClient as any, { usdc: USDC, forge: FORGE, owner: a.address, required: amount });
  const r = await runCosponsorFlow({
    baseUrl: BACKEND, bearerToken: a.token, signer: a.address, questionId: q.id, qid: pre.qid as Hex,
    nonce: BigInt(pre.nonce ?? "0"),
    expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
    forgeAddress: FORGE, chainId: pre.chainId ?? CHAIN_ID,
    expectedIntentHash: pre.expectedIntentHash as Hex,
    token: pre.token.contractAddress as Address, amount, feeAmount: 0n,
    // Echo the backend-advertised policy feeShares verbatim (realized-outcome;
    // chain requires non-empty per shape:cosponsor:feeShares-required).
    feeShares: (pre.feeShares ?? []).map((s) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints })),
    feeShareBps: Number(pre.feeShareBps ?? 0),
    walletClient: wc, privateKey: a.wallet.privateKey as Hex,
  });
  await awaitReceipt(publicClient as any, r.txHash!);
  a.cosponsored.add(q.id);
  log(a.name, `COSPO ${q.id} +${SPONSOR_AMOUNT} USDC "${q.title.slice(0, 30)}"`);
}

// ── Decide + act one tick ────────────────────────────────────────
async function tick(a: Agent): Promise<void> {
  const open = await listOpenQuestions(a.token);
  const self = a.address.toLowerCase();
  const solvable = open.filter((q) => q.author !== self && !a.solved.has(q.id));
  const cosponsorable = open.filter((q) => q.author !== self && !a.solved.has(q.id) && !a.sponsored.has(q.id));
  const voteCand = open.filter((q) => q.author !== self && !a.voted.has(q.id) && !a.solved.has(q.id));

  // Weighted menu — pure policy (src/swarm/policy.ts). A broke agent only idles
  // (insufficient-funds reverts are deterministic — don't retry, resume on
  // refund). Below WARM_FLOOR every persona refills the board even past its ask
  // cap (keep-warm), so a forever-run never drains; above it the cap bounds
  // production. Cosponsor re-enabled (Finding-A fix 4ddfdea, validated Q9).
  const menu = buildActionMenu({
    broke: a.broke,
    openCount: open.length,
    asksSoFar: a.acts["ask"] ?? 0,
    maxAsks: MAX_ASKS_PER_AGENT,
    warmFloor: WARM_FLOOR,
    solvableCount: solvable.length,
    votableCount: voteCand.length,
    cosponsorableCount: cosponsorable.length,
    weights: a.persona.weights,
  });

  const total = menu.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * total;
  let choice = "idle";
  for (const [act, w] of menu) { if ((roll -= w) <= 0) { choice = act; break; } }

  a.acts[choice] = (a.acts[choice] ?? 0) + 1;
  try {
    if (choice === "ask") await actAsk(a);
    else if (choice === "solve") await actSolve(a, pick(solvable));
    else if (choice === "cosponsor") await actCosponsor(a, pick(cosponsorable));
    else if (choice === "vote") {
      // Resolve a votable question (one with confirmed, non-self solutions).
      const shuffled = [...voteCand].sort(() => Math.random() - 0.5);
      for (const q of shuffled.slice(0, 4)) {
        const sols = await confirmedSolutions(q.id, a.token);
        if (sols.some((s) => s.author !== self)) { await actVote(a, q, sols); return; }
      }
      // No votable target right now — fall back to a cheap read tick.
      a.acts["vote"]--; a.acts["idle_no_target"] = (a.acts["idle_no_target"] ?? 0) + 1;
    }
  } catch (e) {
    // Surface the real revert reason: viem buries it in shortMessage, not the
    // generic header that split("\n")[0] used to log (that hid every
    // "insufficient balance" behind "The contract function reverted").
    const m = broadcastErrorMessage(e);
    if (isInsufficientFunds(e)) {
      a.broke = true; // deterministic precondition failure — stop funded actions, don't loop
      log(a.name, `✗ ${choice}: insufficient funds — pausing funded actions (fund the wallet to resume). ${m.slice(0, 200)}`);
    } else {
      log(a.name, `✗ ${choice}: ${m.slice(0, 320)}`);
    }
  }
}

async function runAgent(a: Agent, deadline: number): Promise<void> {
  // Jittered start so agents don't all fire in lockstep.
  await sleep(rand(0, 4000));
  while (Date.now() < deadline) {
    try { await tick(a); } catch (e) { log(a.name, `tick error: ${(e as Error).message?.slice(0, 120)}`); }
    await sleep(rand(TICK_MIN_MS, TICK_MAX_MS));
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`organic-swarm | backend ${BACKEND} | forge ${FORGE} | chain ${CHAIN_ID}`);
  console.log(`agents: ${AGENT_NAMES.join(", ")} | duration ${DURATION_SEC <= 0 ? "∞ (continuous)" : DURATION_SEC + "s"} | tick ${TICK_MIN_MS}-${TICK_MAX_MS}ms`);
  console.log(`specialization: ${SPEC.label} | blend: ${BLEND} | ${TOPICS.length} topic seed(s)\n`);

  const personas = assignPersonas(AGENT_NAMES.length, BLEND);
  const agents: Agent[] = [];
  // pIdx advances only on KNOWN agents — a skipped unknown name must not
  // misalign the surviving agents' personas (the persona cycle is positional).
  let pIdx = 0;
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    const name = AGENT_NAMES[i];
    const idx = POOL[name];
    if (idx === undefined) { console.log(`! unknown agent ${name}, skipping`); continue; }
    const wallet = deriveAgentWallet(MNEMONIC, idx, CHAIN_ID);
    const token = await sessions.ensureToken(wallet);
    const persona = personas[pIdx++];
    agents.push({
      name, persona, wallet, address: wallet.address as Address, token,
      sponsored: new Set(), solved: new Set(), voted: new Set(), cosponsored: new Set(), acts: {},
      broke: false,
    });
    log(name, `online ${persona.label} (${wallet.address})`);
  }

  const deadline = resolveDeadlineMs(DURATION_SEC, Date.now());
  // Periodic heartbeat summarizing aggregate activity.
  const hb = setInterval(() => {
    const agg: Record<string, number> = {};
    for (const a of agents) for (const [k, v] of Object.entries(a.acts)) agg[k] = (agg[k] ?? 0) + v;
    const left = Number.isFinite(deadline)
      ? `${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s left`
      : "continuous";
    console.log(`${ts()} ── heartbeat: ${Object.entries(agg).map(([k, v]) => `${k}=${v}`).join(" ")} | ${left}`);
  }, 30000);

  await Promise.all(agents.map((a) => runAgent(a, deadline)));
  clearInterval(hb);

  console.log(`\n── organic swarm complete ──`);
  for (const a of agents) {
    console.log(`  ${a.name.padEnd(6)} ${a.persona.label.padEnd(11)} sponsored=${a.sponsored.size} solved=${a.solved.size} voted=${a.voted.size} cosponsored=${a.cosponsored.size} | acts ${JSON.stringify(a.acts)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
