#!/usr/bin/env tsx
// broadcast-swarm.ts — stochastic activity simulation.
//
// 4 agents pick random actions opportunistically; we watch for bugs,
// flaws, and Sybil-style misbehavior. No rigid round order.
//
// Each tick (every ~2-4s) one agent picks an action:
//
//   create_problem  — fund a new problem (1 USDC bounty)
//   commit_solution — commit on a random OPEN problem
//   cast_vote       — vote on a random problem with solutions
//   settle          — oracle (w0) settles a round-ready problem
//   claim_winner    — claim Merkle leaf if eligible
//   sybil_self_commit — try to commit on own problem (must FAIL)
//   sybil_self_vote   — try to vote on own solution (must FAIL)
//   sybil_double_commit — same wallet commits twice to one problem
//                          (must FAIL with duplicate-intent_hash)
//
// At the end, snapshot balances + problem states + any anomalies.
//
// USAGE: source .env and run; defaults to RT_ROUTER_ADDRESS from env
// or the v2.3 testnet deploy.

import type { Address, Hex } from "viem";
import { createPublicClient, http, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import type { AgentWallet } from "../src/wallet/types.js";
import {
  buildFundIntentTypedData,
  buildFundRequestBody,
  parseAmountToWei,
} from "../src/intents/fund-intent.js";
import {
  buildCommitIntentTypedData,
  buildSubmitCommitRequestBody,
  computeContentHash,
} from "../src/intents/commit-intent.js";
import {
  type Allocation,
  buildSubmitVoteIntentRequestBody,
  buildVoteIntentTypedData,
  computeAllocationsHash,
} from "../src/intents/vote-intent.js";
import type {
  CommitPreflight,
  FundPreflight,
  VotePreflight,
} from "../src/intents/preflight-types.js";
import {
  awaitReceipt,
  broadcastCommit,
  broadcastFund,
  broadcastVote,
  makeAgentWalletClient,
} from "../src/router/client.js";
import { signUSDCPermit } from "../src/router/permit.js";
import { fmtUsdc } from "../src/accounting/balances.js";

const BACKEND = process.env.RT_BACKEND_URL ?? "http://localhost:8080";
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = 84532;
const USDC: Address =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROUTER = (process.env.RT_ROUTER_ADDRESS as Address | undefined) ??
  "0x946d489e8a8ae877f1f063d3ed03571e2dc86e5e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const TICKS = Number(process.env.SWARM_TICKS ?? "20");
const MIN_SLEEP_MS = 2000;
const MAX_SLEEP_MS = 5000;

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};
const ts = () => new Date().toISOString().slice(11, 19);
const log = (tick: number, label: string, msg: string) =>
  console.log(`${c.dim(ts())} ${c.cyan(`[${tick.toString().padStart(2)}]`)} ${label} ${msg}`);
const ok = (tick: number, label: string, msg: string) =>
  console.log(`${c.dim(ts())} ${c.cyan(`[${tick.toString().padStart(2)}]`)} ${c.green("✓")} ${label} ${msg}`);
const fail = (tick: number, label: string, msg: string) =>
  console.log(`${c.dim(ts())} ${c.cyan(`[${tick.toString().padStart(2)}]`)} ${c.red("✗")} ${label} ${msg}`);
const note = (tick: number, label: string, msg: string) =>
  console.log(`${c.dim(ts())} ${c.cyan(`[${tick.toString().padStart(2)}]`)} ${c.yellow("!")} ${label} ${msg}`);

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

// ─── State tracking ───────────────────────────────────────────────

interface Problem {
  id: string;
  criterionId: string;
  funderLabel: string;
  active: boolean; // OPEN per backend's view
  solutions: { id: string; authorLabel: string }[];
  voters: Set<string>; // labels who already voted
  committers: Set<string>; // labels who already committed
}

interface Agent {
  label: string;
  wallet: AgentWallet;
  address: Address;
  token: string;
  walletClient: ReturnType<typeof makeAgentWalletClient>;
}

interface Anomaly {
  tick: number;
  kind: string;
  detail: string;
}

const anomalies: Anomaly[] = [];
const problems = new Map<string, Problem>();
const counts: Record<string, number> = {};

function bumpCount(action: string, outcome: string) {
  const k = `${action}.${outcome}`;
  counts[k] = (counts[k] ?? 0) + 1;
}

// ─── HTTP helper ──────────────────────────────────────────────────

async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ ok: boolean; status: number; data: T; errCode?: string; errMsg?: string }> {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = raw;
  }
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } }).error;
    return {
      ok: false,
      status: res.status,
      data: parsed as T,
      errCode: err?.code,
      errMsg: err?.message,
    };
  }
  return { ok: true, status: res.status, data: parsed as T };
}

async function login(wallet: AgentWallet): Promise<{ token: string; address: Address }> {
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300, // 5 min — backend ceiling is 15
    domain: loadLoginDomain(),
  });
  const r = await call<{ access_token: string; address: Address }>("POST", "/auth/wallet", body);
  if (!r.ok) throw new Error(`login failed: ${r.errCode ?? r.status}`);
  return { token: r.data.access_token, address: r.data.address };
}

async function balance(pub: ReturnType<typeof createPublicClient>, addr: Address): Promise<bigint> {
  return (await pub.readContract({
    address: USDC, abi: ERC20, functionName: "balanceOf", args: [addr],
  })) as bigint;
}

// ─── Action: create_problem ────────────────────────────────────────

async function actionCreateProblem(
  tick: number,
  agent: Agent,
  pub: ReturnType<typeof createPublicClient>,
): Promise<void> {
  // Backend-side problem creation, then on-chain fund.
  const p = await call<{ id: string; success_criteria: { id: string }[] }>(
    "POST", "/v1/problems",
    {
      title: `swarm-${tick}-${agent.label} ${Date.now()}`,
      description: `Agent ${agent.label}'s tick-${tick} problem.`,
      success_criteria: [{ name: "primary", type: "boolean", target: "true", weight: 100 }],
      initial_bounty: "0",
    },
    agent.token,
  );
  if (!p.ok) {
    fail(tick, agent.label, `POST /v1/problems → ${p.errCode}: ${p.errMsg}`);
    bumpCount("create_problem", "fail_create");
    return;
  }

  // Fund 1 USDC.
  const fundPre = await call<FundPreflight>(
    "GET", `/v1/problems/${p.data.id}/fund/preflight?funder=${agent.address}`,
  );
  if (!fundPre.ok) {
    fail(tick, agent.label, `preflight fund: ${fundPre.errCode}`);
    bumpCount("create_problem", "fail_preflight");
    return;
  }
  const fundAmount = parseAmountToWei("1", fundPre.data.token.decimals);
  const fundTd = buildFundIntentTypedData({
    preflight: fundPre.data,
    funder: agent.address,
    amountWei: fundAmount,
  });
  const fundSig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(fundTd)) as Hex;
  const submit = await call<{ intent_hash: string }>(
    "POST", `/v1/problems/${p.data.id}/fund`,
    buildFundRequestBody({ typedData: fundTd, signature: fundSig }),
    agent.token,
  );
  if (!submit.ok) {
    fail(tick, agent.label, `fund-intent: ${submit.errCode}`);
    bumpCount("create_problem", "fail_intent");
    return;
  }
  const fundPermit = await signUSDCPermit(agent.walletClient, pub, {
    usdc: USDC, spender: ROUTER, value: fundAmount,
    deadline: fundTd.message.expiresAt,
  });
  try {
    const tx = await broadcastFund(agent.walletClient, {
      routerAddress: ROUTER,
      intent: fundTd.message,
      intentSig: fundSig,
      permit: fundPermit,
      gas: 350_000n,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `created+funded ${p.data.id.slice(0, 14)}… (1 USDC, tx ${tx.slice(0, 14)}…)`);
    problems.set(p.data.id, {
      id: p.data.id,
      criterionId: p.data.success_criteria[0].id,
      funderLabel: agent.label,
      active: true,
      solutions: [],
      voters: new Set(),
      committers: new Set(),
    });
    bumpCount("create_problem", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(tick, agent.label, `Router.fund revert: ${msg.slice(0, 120)}`);
    bumpCount("create_problem", "fail_chain");
    anomalies.push({ tick, kind: "fund_revert", detail: msg.slice(0, 200) });
  }
}

// ─── Action: commit_solution ───────────────────────────────────────

async function actionCommitSolution(
  tick: number,
  agent: Agent,
  pub: ReturnType<typeof createPublicClient>,
  forceProblem?: Problem,
): Promise<void> {
  // Pick an OPEN problem the agent can legally commit to: not the
  // funder, hasn't committed already.
  const candidates = forceProblem
    ? [forceProblem]
    : Array.from(problems.values()).filter(
        (p) =>
          p.active &&
          p.funderLabel !== agent.label &&
          !p.committers.has(agent.label),
      );
  if (candidates.length === 0) {
    note(tick, agent.label, `no eligible problem to commit to`);
    bumpCount("commit_solution", "no_eligible");
    return;
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];

  const commitPre = await call<CommitPreflight>(
    "GET", `/v1/problems/${target.id}/commit/preflight?submitter=${agent.address}`,
  );
  if (!commitPre.ok) {
    fail(tick, agent.label, `commit preflight ${target.id.slice(0, 14)}…: ${commitPre.errCode}`);
    bumpCount("commit_solution", `fail_preflight_${commitPre.errCode}`);
    return;
  }
  const body = `Solution from ${agent.label} at tick ${tick} for ${target.id.slice(0, 14)}…`;
  const contentHash = computeContentHash(body);
  const td = buildCommitIntentTypedData({
    preflight: commitPre.data, submitter: agent.address, contentHash,
  });
  const sig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(td)) as Hex;
  const intent = await call<{ intent_hash: string }>(
    "POST", `/v1/problems/${target.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: td, signature: sig }),
    agent.token,
  );
  if (!intent.ok) {
    fail(tick, agent.label, `commit intent ${target.id.slice(0, 14)}…: ${intent.errCode}: ${intent.errMsg}`);
    bumpCount("commit_solution", `fail_intent_${intent.errCode}`);
    if (intent.errCode === "PROBLEM_OWN_SOLUTION") {
      // Expected when sybil_self_commit; otherwise a real bug.
      anomalies.push({ tick, kind: "self_commit_blocked", detail: `${agent.label} on ${target.id}` });
    }
    return;
  }
  const solResp = await call<{ id: string }>(
    "POST", `/v1/problems/${target.id}/solutions`,
    {
      intent_hash: intent.data.intent_hash,
      summary: body,
      reasoning_tree: [{ because: "Because", therefore: "Therefore" }],
      claims: [{ criterion_id: target.criterionId, value: true, argument: "ok", falsifiable_by: "no" }],
    },
    agent.token,
  );
  if (!solResp.ok) {
    fail(tick, agent.label, `solution body ${target.id.slice(0, 14)}…: ${solResp.errCode}`);
    bumpCount("commit_solution", `fail_solution_${solResp.errCode}`);
    return;
  }
  const fee = BigInt(td.message.feeAmount);
  const bond = BigInt(td.message.bondAmount);
  const permit = await signUSDCPermit(agent.walletClient, pub, {
    usdc: USDC, spender: ROUTER, value: fee + bond,
    deadline: td.message.expiresAt,
  });
  try {
    const tx = await broadcastCommit(agent.walletClient, {
      routerAddress: ROUTER, intent: td.message, intentSig: sig, permit,
      gas: 400_000n,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `committed to ${target.id.slice(0, 14)}… bond ${fmtUsdc(bond)} (tx ${tx.slice(0, 14)}…)`);
    target.committers.add(agent.label);
    target.solutions.push({ id: solResp.data.id, authorLabel: agent.label });
    bumpCount("commit_solution", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(tick, agent.label, `Router.commitSolution revert: ${msg.slice(0, 120)}`);
    bumpCount("commit_solution", "fail_chain");
    anomalies.push({ tick, kind: "commit_revert", detail: msg.slice(0, 200) });
  }
}

// ─── Action: cast_vote ─────────────────────────────────────────────

async function actionCastVote(
  tick: number,
  agent: Agent,
  pub: ReturnType<typeof createPublicClient>,
): Promise<void> {
  const candidates = Array.from(problems.values()).filter(
    (p) =>
      p.active &&
      p.solutions.length > 0 &&
      p.funderLabel !== agent.label &&
      !p.voters.has(agent.label) &&
      !p.solutions.some((s) => s.authorLabel === agent.label),
  );
  if (candidates.length === 0) {
    note(tick, agent.label, `no eligible problem to vote on`);
    bumpCount("cast_vote", "no_eligible");
    return;
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const sol = target.solutions[Math.floor(Math.random() * target.solutions.length)];

  const votePre = await call<VotePreflight>(
    "GET", `/v1/problems/${target.id}/vote/preflight?voter=${agent.address}`,
  );
  if (!votePre.ok) {
    fail(tick, agent.label, `vote preflight ${target.id.slice(0, 14)}…: ${votePre.errCode}`);
    bumpCount("cast_vote", `fail_preflight_${votePre.errCode}`);
    return;
  }
  const allocations: Allocation[] = [{ solution_id: sol.id, points: 100 }];
  const allocationsHash = computeAllocationsHash(allocations);
  const td = buildVoteIntentTypedData({
    preflight: votePre.data, voter: agent.address, allocationsHash,
  });
  const sig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(td)) as Hex;
  const intent = await call<{ intent_hash: string }>(
    "POST", `/v1/problems/${target.id}/vote-intent`,
    buildSubmitVoteIntentRequestBody({ typedData: td, allocations, signature: sig }),
    agent.token,
  );
  if (!intent.ok) {
    fail(tick, agent.label, `vote intent ${target.id.slice(0, 14)}…: ${intent.errCode}: ${intent.errMsg}`);
    bumpCount("cast_vote", `fail_intent_${intent.errCode}`);
    return;
  }
  const fee = BigInt(td.message.feeAmount);
  const bond = BigInt(td.message.bondAmount);
  const permit = await signUSDCPermit(agent.walletClient, pub, {
    usdc: USDC, spender: ROUTER, value: fee + bond,
    deadline: td.message.expiresAt,
  });
  try {
    const tx = await broadcastVote(agent.walletClient, {
      routerAddress: ROUTER, intent: td.message, intentSig: sig, permit,
      gas: 400_000n,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `voted on ${target.id.slice(0, 14)}… for ${sol.authorLabel}'s soln bond ${fmtUsdc(bond)} (tx ${tx.slice(0, 14)}…)`);
    target.voters.add(agent.label);
    bumpCount("cast_vote", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(tick, agent.label, `Router.castVote revert: ${msg.slice(0, 120)}`);
    bumpCount("cast_vote", "fail_chain");
    anomalies.push({ tick, kind: "vote_revert", detail: msg.slice(0, 200) });
  }
}

// ─── Sybil probes ─────────────────────────────────────────────────

async function probeSelfCommit(tick: number, agent: Agent, pub: ReturnType<typeof createPublicClient>) {
  // Find a problem the agent funded; try to commit to it.
  const own = Array.from(problems.values()).find((p) => p.funderLabel === agent.label && p.active);
  if (!own) {
    note(tick, agent.label, `no own problem yet to self-commit-probe`);
    return;
  }
  log(tick, agent.label, `${c.magenta("PROBE")} self-commit on own problem ${own.id.slice(0, 14)}…`);
  await actionCommitSolution(tick, agent, pub, own);
}

// ─── Main loop ────────────────────────────────────────────────────

async function pickAction(tick: number, agent: Agent): Promise<string> {
  // Bias the action mix based on what's possible in the current
  // state. Early ticks favor create; later ticks favor commit/vote.
  const openProblems = Array.from(problems.values()).filter((p) => p.active);
  const withSolutions = openProblems.filter((p) => p.solutions.length > 0);

  const actions: { name: string; weight: number }[] = [
    { name: "create_problem", weight: openProblems.length < 2 ? 5 : 1 },
    { name: "commit_solution", weight: openProblems.length > 0 ? 3 : 0 },
    { name: "cast_vote", weight: withSolutions.length > 0 ? 3 : 0 },
  ];
  // Inject a sybil probe at fixed ticks for observability.
  if (tick === 5) actions.push({ name: "sybil_self_commit", weight: 999 });

  const total = actions.reduce((s, a) => s + a.weight, 0);
  if (total === 0) return "idle";
  let r = Math.random() * total;
  for (const a of actions) {
    r -= a.weight;
    if (r <= 0) return a.name;
  }
  return actions[0].name;
}

async function main() {
  console.log(c.bold(`swarm simulation — ${TICKS} ticks against router ${ROUTER}`));

  const wallets = [0, 1, 2, 4].map((n) => deriveAgentWallet(MNEMONIC!, n, CHAIN_ID));
  const labels = ["a", "b", "c", "d"];
  const agents: Agent[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const auth = await login(w);
    agents.push({
      label: labels[i],
      wallet: w,
      address: auth.address,
      token: auth.token,
      walletClient: makeAgentWalletClient({
        privateKey: w.privateKey, chainId: CHAIN_ID, rpcUrl: RPC,
      }),
    });
  }
  const pub = createPublicClient({ transport: http(RPC) });

  // Snapshot starting balances.
  const startBals = new Map<string, bigint>();
  for (const a of agents) startBals.set(a.label, await balance(pub, a.address));
  console.log(c.bold("\nStarting balances:"));
  for (const a of agents) console.log(`  ${a.label} ${a.address}  ${fmtUsdc(startBals.get(a.label)!)} USDC`);
  console.log("");

  // Tick loop.
  for (let tick = 1; tick <= TICKS; tick++) {
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const action = await pickAction(tick, agent);
    log(tick, c.blue(agent.label), `→ ${c.bold(action)}`);
    try {
      switch (action) {
        case "create_problem":
          await actionCreateProblem(tick, agent, pub);
          break;
        case "commit_solution":
          await actionCommitSolution(tick, agent, pub);
          break;
        case "cast_vote":
          await actionCastVote(tick, agent, pub);
          break;
        case "sybil_self_commit":
          await probeSelfCommit(tick, agent, pub);
          break;
        case "idle":
          note(tick, agent.label, "no action available");
          break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(tick, agent.label, `unhandled exception: ${msg.slice(0, 200)}`);
      anomalies.push({ tick, kind: "unhandled", detail: msg.slice(0, 300) });
    }

    const sleep = MIN_SLEEP_MS + Math.random() * (MAX_SLEEP_MS - MIN_SLEEP_MS);
    await new Promise((r) => setTimeout(r, sleep));
  }

  // Final snapshot + report.
  await new Promise((r) => setTimeout(r, 4000)); // allow last tx to settle
  console.log("");
  console.log(c.bold(c.magenta("━━━━━━━━━━ Final balances ━━━━━━━━━━")));
  for (const a of agents) {
    const end = await balance(pub, a.address);
    const delta = end - startBals.get(a.label)!;
    console.log(`  ${a.label}  ${fmtUsdc(end).padStart(14)}  Δ ${fmtUsdc(delta).padStart(12)}`);
  }

  console.log(c.bold(c.magenta("\n━━━━━━━━━━ Action counts ━━━━━━━━━━")));
  for (const k of Object.keys(counts).sort()) {
    console.log(`  ${k.padEnd(45)} ${counts[k]}`);
  }

  console.log(c.bold(c.magenta("\n━━━━━━━━━━ Problems created ━━━━━━━━━━")));
  for (const p of problems.values()) {
    console.log(`  ${p.id}  funder=${p.funderLabel}  solns=${p.solutions.length} (${p.solutions.map(s=>s.authorLabel).join(",")})  voters=${[...p.voters].join(",")}`);
  }

  console.log(c.bold(c.magenta("\n━━━━━━━━━━ Anomalies ━━━━━━━━━━")));
  if (anomalies.length === 0) {
    console.log("  (none)");
  } else {
    for (const a of anomalies) {
      console.log(`  [${a.tick.toString().padStart(2)}] ${c.yellow(a.kind)} — ${a.detail}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n\x1b[31m[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
