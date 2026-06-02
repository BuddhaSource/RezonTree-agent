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
import { resolveSpecialization } from "../src/personas/registry.js";
import { assignPersonas, type Blend } from "../src/bootstrap/onboard.js";
import { resolveDeadlineMs, explainDecision } from "../src/swarm/policy.js";
import type { VoteSolution } from "../src/voting/matrix.js";
import { makeAgentWalletClient } from "../src/forge/quadphase-broadcast.js";
import { askFlow, solveFlow, voteFlow, cosponsorFlow } from "../src/orchestration/registry.js";
import { resolveSink, loadVoice, shareAfterAction } from "../src/social/index.js";
import { resolveReferral } from "../src/social/growth.js";
import type { Agent, OpenQ, FlowCtx, SwarmConfig } from "../src/orchestration/types.js";
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
const INITIAL_BOUNTY = process.env.RT_INITIAL_BOUNTY ?? "1000000";
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

// Agent / OpenQ / FlowCtx types now live in src/orchestration/types.ts — the
// flows and this harness share them. Question authoring (makeDescription) moved
// into flows/ask.ts with the flow that uses it.

const sessions = sessionManagerFor(BACKEND);

// Build the flow context once — config + clients + HTTP helpers the
// deterministic flows capture. Flows read nothing from module scope; the
// selector below picks which one runs, identically for every agent.
// Social share — opt-in (RT_SOCIAL_SHARE=1); undefined ⇒ no share hook. A share
// failure is swallowed: it must never undo or block a confirmed on-chain action.
const SITE_URL = process.env.RT_SITE_URL ?? "https://rezontree.com";
const shareSink = resolveSink();
const shareVoice = shareSink ? loadVoice() : undefined;
// Referral CTA appended to every share when configured — the agent-native
// referral funnel (toward the 30%-referral goal). No code ⇒ no CTA.
const shareReferral = resolveReferral();

const flowCtx: FlowCtx = {
  cfg: {
    backend: BACKEND, rpc: RPC, chainId: CHAIN_ID, forge: FORGE, usdc: USDC,
    sponsorAmount: SPONSOR_AMOUNT, initialBounty: INITIAL_BOUNTY, topics: TOPICS,
  } satisfies SwarmConfig,
  publicClient,
  makeWc,
  call,
  preflight: preflightV2,
  log,
  share: shareSink
    ? async (ev) => {
        try {
          await shareAfterAction({ ...ev, url: `${SITE_URL}/questions/${ev.questionId}` }, shareSink, shareVoice, shareReferral);
        } catch (e) {
          log(ev.agent, `share failed (non-fatal): ${(e as Error).message?.slice(0, 120)}`);
        }
      }
    : undefined,
};

// ── Discovery ────────────────────────────────────────────────────
async function listOpenQuestions(token: string): Promise<OpenQ[]> {
  const r = await call<{ data?: any[] }>("GET", `/v1/questions?status=open`, undefined, token);
  const data = (r.body?.data ?? []) as any[];
  return data.map((q) => ({ id: q.id, author: (q.authorAddress ?? "").toLowerCase(), title: q.title ?? "" }));
}

// Project the confirmed-solutions list into VoteSolution shape (intentHash,
// author, stake, claims) so the sharp decider can judge them. Claims/stake are
// read defensively — if the projection omits them the decider degrades to a
// structural tie and actVote's even-split fallback keeps the vote path live.
async function confirmedSolutions(qid: string, token: string): Promise<VoteSolution[]> {
  const r = await call<{ solutions?: { data?: any[] } }>("GET", `/v1/questions/${qid}?include=solutions`, undefined, token);
  const list = (r.body?.solutions?.data ?? []) as any[];
  return list
    .map((s): VoteSolution => ({
      intentHash: (s.intentHash ?? s.intent_hash ?? "").toString(),
      author: (s.authorAddress ?? "").toLowerCase(),
      stakeWei: BigInt(s.chainStakeAmount ?? s.stakeAmount ?? s.stake_amount ?? 0),
      claims: Array.isArray(s.claims)
        ? s.claims.map((c: any) => ({
            criterionId: (c.criterionId ?? c.criterion_id ?? "").toString(),
            value: c.value,
            argument: typeof c.argument === "string" ? c.argument : undefined,
            falsifiableBy: typeof (c.falsifiableBy ?? c.falsifiable_by) === "string" ? (c.falsifiableBy ?? c.falsifiable_by) : undefined,
          }))
        : [],
    }))
    .filter((s) => s.intentHash.startsWith("0x"));
}

// The four action flows are deterministic CODE in src/orchestration/flows/.
// This harness builds a FlowCtx (config + clients + HTTP helpers) once and the
// selector below picks which flow to run per tick — same flow for every agent.

// ── Decide + act one tick ────────────────────────────────────────
async function tick(a: Agent): Promise<void> {
  const open = await listOpenQuestions(a.token);
  const self = a.address.toLowerCase();
  const solvable = open.filter((q) => q.author !== self && !a.solved.has(q.id));
  const cosponsorable = open.filter((q) => q.author !== self && !a.solved.has(q.id) && !a.sponsored.has(q.id) && !a.cosponsored.has(q.id));
  const voteCand = open.filter((q) => q.author !== self && !a.voted.has(q.id) && !a.solved.has(q.id));

  // Decide + explain in one pure call (src/swarm/policy.ts). A broke agent only
  // idles (insufficient-funds reverts are deterministic — don't retry, resume on
  // refund). Below WARM_FLOOR every persona refills the board even past its ask
  // cap (keep-warm), so a forever-run never drains; above it the cap bounds
  // production. The reasons surface WHY the action was chosen, no extra reads.
  const decision = explainDecision({
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
  const choice = decision.choice;
  if (choice !== "idle") log(a.name, `DECIDE ${decision.reasons.join("; ")}`);

  a.acts[choice] = (a.acts[choice] ?? 0) + 1;
  try {
    if (choice === "ask") await askFlow.run(a, undefined, flowCtx);
    else if (choice === "solve") await solveFlow.run(a, pick(solvable), flowCtx);
    else if (choice === "cosponsor") await cosponsorFlow.run(a, pick(cosponsorable), flowCtx);
    else if (choice === "vote") {
      // Resolve a votable question (one with confirmed, non-self solutions),
      // then hand the question + its solutions to the vote flow.
      const shuffled = [...voteCand].sort(() => Math.random() - 0.5);
      for (const q of shuffled.slice(0, 4)) {
        const sols = await confirmedSolutions(q.id, a.token);
        if (sols.some((s) => s.author !== self)) { await voteFlow.run(a, { q, sols }, flowCtx); return; }
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
