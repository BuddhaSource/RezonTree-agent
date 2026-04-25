#!/usr/bin/env tsx
// broadcast-swarm-full.ts — continuous full-lifecycle stochastic
// activity. Drives 4 agents through CREATE / FUND / COMMIT / VOTE
// / SETTLE / CLAIM / BOND_CLAIM / REFUND, picking actions
// opportunistically based on observed problem states. When a
// round's deadline elapses, an agent (the oracle) settles it; then
// winners claim leaves and non-slashed bondholders reclaim bonds.
//
// Designed to surface: indexer drift, status-machine races,
// double-claim attempts, slash interactions, expired-refund races,
// and Sybil-style misbehavior under extended run.
//
// Backend MUST be running with ROUND_DURATION_SECONDS short
// (recommended 180s) so deadlines elapse within the simulation.

import type { Address, Hex } from "viem";
import { createPublicClient, http, parseAbi } from "viem";
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
  DEFAULT_SETTLEMENT_TTL_SECONDS,
  buildSettlementIntentTypedData,
} from "../src/intents/settlement-intent.js";
import {
  hashLeaf,
  merkleProof,
  merkleRoot,
  type MerkleLeaf,
} from "../src/intents/merkle.js";
import { ROUTER_V2_ABI } from "../src/router/abi.js";
import {
  awaitReceipt,
  broadcastClaim,
  broadcastCommit,
  broadcastFund,
  broadcastPublishSettlement,
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

const TICKS = Number(process.env.SWARM_TICKS ?? "60");
const MIN_SLEEP_MS = 3000;
const MAX_SLEEP_MS = 7000;
const PLATFORM_FEE_BPS = 1000n; // 10%

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

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ─── Types ─────────────────────────────────────────────────────────

type ProblemState = "open" | "settled" | "expired" | "drained";

interface Solution {
  id: string;
  intentHash: Hex;
  authorLabel: string;
  bondWei: bigint;
  slashed: boolean;
  bondClaimed: boolean;
}

interface Vote {
  voterLabel: string;
  intentHash: Hex;
  forSolutionLabel: string;
  bondWei: bigint;
  slashed: boolean;
  bondClaimed: boolean;
}

interface Problem {
  id: string;
  qid: Hex;
  criterionId: string;
  funderLabel: string;
  fundContribs: Map<string, bigint>; // label -> amount funded
  deadlineUnix: number; // local-clock approximation
  state: ProblemState;
  solutions: Solution[];
  votes: Vote[];

  // After settle:
  winnerLabel?: string;
  merkleLeaves?: MerkleLeaf[];
  leafByRecipient?: Map<Address, MerkleLeaf>;
  poolWei?: bigint;
  feeWei?: bigint;
  winnerAmountWei?: bigint;
  claimedRecipients?: Set<Address>;
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

// ─── HTTP ──────────────────────────────────────────────────────────

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
      ok: false, status: res.status, data: parsed as T,
      errCode: err?.code, errMsg: err?.message,
    };
  }
  return { ok: true, status: res.status, data: parsed as T };
}

async function login(wallet: AgentWallet): Promise<{ token: string; address: Address }> {
  const body = await signWalletLoginIntent({
    wallet, expiresAt: Math.floor(Date.now() / 1000) + 300, domain: loadLoginDomain(),
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

async function actCreate(tick: number, agent: Agent, pub: ReturnType<typeof createPublicClient>) {
  const p = await call<{ id: string; success_criteria: { id: string }[] }>(
    "POST", "/v1/problems",
    {
      title: `swarm-${tick}-${agent.label} ${Date.now()}`,
      description: `Tick ${tick} from ${agent.label}`,
      success_criteria: [{ name: "primary", type: "boolean", target: "true", weight: 100 }],
      initial_bounty: "0",
    },
    agent.token,
  );
  if (!p.ok) {
    fail(tick, agent.label, `POST /v1/problems → ${p.errCode}`);
    bumpCount("create", "fail_create");
    return;
  }
  const fundPre = await call<FundPreflight>(
    "GET", `/v1/problems/${p.data.id}/fund/preflight?funder=${agent.address}`,
  );
  if (!fundPre.ok) {
    fail(tick, agent.label, `preflight: ${fundPre.errCode}`);
    bumpCount("create", "fail_preflight");
    return;
  }
  const fundAmount = parseAmountToWei("1", fundPre.data.token.decimals);
  const fundTd = buildFundIntentTypedData({
    preflight: fundPre.data, funder: agent.address, amountWei: fundAmount,
  });
  const fundSig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(fundTd)) as Hex;
  const submit = await call<{ intent_hash: string; chain_question_id: string }>(
    "POST", `/v1/problems/${p.data.id}/fund`,
    buildFundRequestBody({ typedData: fundTd, signature: fundSig }),
    agent.token,
  );
  if (!submit.ok) {
    fail(tick, agent.label, `fund-intent: ${submit.errCode}`);
    bumpCount("create", "fail_intent");
    return;
  }
  const fundPermit = await signUSDCPermit(agent.walletClient, pub, {
    usdc: USDC, spender: ROUTER, value: fundAmount, deadline: fundTd.message.expiresAt,
  });
  try {
    const tx = await broadcastFund(agent.walletClient, {
      routerAddress: ROUTER, intent: fundTd.message, intentSig: fundSig, permit: fundPermit,
      gas: 350_000n,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `created+funded ${p.data.id.slice(0, 14)}… (1 USDC)`);
    const prob: Problem = {
      id: p.data.id,
      qid: fundTd.message.questionId,
      criterionId: p.data.success_criteria[0].id,
      funderLabel: agent.label,
      fundContribs: new Map([[agent.label, fundAmount]]),
      deadlineUnix: Number(fundPre.data.funding_deadline ?? 0),
      state: "open",
      solutions: [],
      votes: [],
    };
    problems.set(p.data.id, prob);
    bumpCount("create", "ok");
  } catch (e) {
    fail(tick, agent.label, `Router.fund revert: ${(e as Error).message.slice(0, 100)}`);
    bumpCount("create", "fail_chain");
    anomalies.push({ tick, kind: "fund_revert", detail: (e as Error).message.slice(0, 200) });
  }
}

// ─── Action: commit_solution ───────────────────────────────────────

async function actCommit(tick: number, agent: Agent, pub: ReturnType<typeof createPublicClient>) {
  const candidates = Array.from(problems.values()).filter(
    (p) =>
      p.state === "open" &&
      p.funderLabel !== agent.label &&
      !p.solutions.some((s) => s.authorLabel === agent.label),
  );
  if (candidates.length === 0) {
    bumpCount("commit", "no_eligible");
    return;
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];

  const pre = await call<CommitPreflight>(
    "GET", `/v1/problems/${target.id}/commit/preflight?submitter=${agent.address}`,
  );
  if (!pre.ok) {
    fail(tick, agent.label, `commit preflight: ${pre.errCode}`);
    bumpCount("commit", `fail_pre_${pre.errCode}`);
    return;
  }
  const body = `Solution ${agent.label}@t${tick} for ${target.id.slice(0, 8)}`;
  const td = buildCommitIntentTypedData({
    preflight: pre.data, submitter: agent.address, contentHash: computeContentHash(body),
  });
  const sig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(td)) as Hex;
  const intent = await call<{ intent_hash: string }>(
    "POST", `/v1/problems/${target.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: td, signature: sig }),
    agent.token,
  );
  if (!intent.ok) {
    fail(tick, agent.label, `commit intent: ${intent.errCode}`);
    bumpCount("commit", `fail_intent_${intent.errCode}`);
    return;
  }
  const sol = await call<{ id: string }>(
    "POST", `/v1/problems/${target.id}/solutions`,
    {
      intent_hash: intent.data.intent_hash, summary: body,
      reasoning_tree: [{ because: "ok", therefore: "ok" }],
      claims: [{ criterion_id: target.criterionId, value: true, argument: "x", falsifiable_by: "y" }],
    },
    agent.token,
  );
  if (!sol.ok) {
    fail(tick, agent.label, `solution body: ${sol.errCode}`);
    bumpCount("commit", `fail_sol_${sol.errCode}`);
    return;
  }
  const fee = BigInt(td.message.feeAmount);
  const bond = BigInt(td.message.bondAmount);
  const permit = await signUSDCPermit(agent.walletClient, pub, {
    usdc: USDC, spender: ROUTER, value: fee + bond, deadline: td.message.expiresAt,
  });
  try {
    const tx = await broadcastCommit(agent.walletClient, {
      routerAddress: ROUTER, intent: td.message, intentSig: sig, permit, gas: 400_000n,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `committed ${target.id.slice(0, 14)}… bond ${fmtUsdc(bond)}`);
    target.solutions.push({
      id: sol.data.id,
      intentHash: intent.data.intent_hash as Hex,
      authorLabel: agent.label,
      bondWei: bond,
      slashed: false,
      bondClaimed: false,
    });
    bumpCount("commit", "ok");
  } catch (e) {
    fail(tick, agent.label, `Router.commitSolution revert: ${(e as Error).message.slice(0, 100)}`);
    bumpCount("commit", "fail_chain");
    anomalies.push({ tick, kind: "commit_revert", detail: (e as Error).message.slice(0, 200) });
  }
}

// ─── Action: cast_vote ─────────────────────────────────────────────

async function actVote(tick: number, agent: Agent, pub: ReturnType<typeof createPublicClient>) {
  const candidates = Array.from(problems.values()).filter(
    (p) =>
      p.state === "open" &&
      p.solutions.length > 0 &&
      p.funderLabel !== agent.label &&
      !p.votes.some((v) => v.voterLabel === agent.label) &&
      !p.solutions.some((s) => s.authorLabel === agent.label),
  );
  if (candidates.length === 0) {
    bumpCount("vote", "no_eligible");
    return;
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const sol = target.solutions[Math.floor(Math.random() * target.solutions.length)];

  const pre = await call<VotePreflight>(
    "GET", `/v1/problems/${target.id}/vote/preflight?voter=${agent.address}`,
  );
  if (!pre.ok) {
    fail(tick, agent.label, `vote preflight: ${pre.errCode}`);
    bumpCount("vote", `fail_pre_${pre.errCode}`);
    return;
  }
  const allocations: Allocation[] = [{ solution_id: sol.id, points: 100 }];
  const td = buildVoteIntentTypedData({
    preflight: pre.data, voter: agent.address,
    allocationsHash: computeAllocationsHash(allocations),
  });
  const sig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(td)) as Hex;
  const intent = await call<{ intent_hash: string }>(
    "POST", `/v1/problems/${target.id}/vote-intent`,
    buildSubmitVoteIntentRequestBody({ typedData: td, allocations, signature: sig }),
    agent.token,
  );
  if (!intent.ok) {
    fail(tick, agent.label, `vote intent: ${intent.errCode}`);
    bumpCount("vote", `fail_intent_${intent.errCode}`);
    return;
  }
  const fee = BigInt(td.message.feeAmount);
  const bond = BigInt(td.message.bondAmount);
  const permit = await signUSDCPermit(agent.walletClient, pub, {
    usdc: USDC, spender: ROUTER, value: fee + bond, deadline: td.message.expiresAt,
  });
  try {
    const tx = await broadcastVote(agent.walletClient, {
      routerAddress: ROUTER, intent: td.message, intentSig: sig, permit, gas: 400_000n,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `voted ${target.id.slice(0, 14)}… for ${sol.authorLabel}`);
    target.votes.push({
      voterLabel: agent.label,
      intentHash: intent.data.intent_hash as Hex,
      forSolutionLabel: sol.authorLabel,
      bondWei: bond,
      slashed: false,
      bondClaimed: false,
    });
    bumpCount("vote", "ok");
  } catch (e) {
    fail(tick, agent.label, `Router.castVote revert: ${(e as Error).message.slice(0, 100)}`);
    bumpCount("vote", "fail_chain");
    anomalies.push({ tick, kind: "vote_revert", detail: (e as Error).message.slice(0, 200) });
  }
}

// ─── Action: settle (oracle = first agent / a) ─────────────────────

async function actSettle(
  tick: number,
  agent: Agent,
  feeWallet: AgentWallet,
  pub: ReturnType<typeof createPublicClient>,
) {
  // Pick a problem whose deadline elapsed and has solutions.
  const now = Math.floor(Date.now() / 1000);
  const candidates = Array.from(problems.values()).filter(
    (p) => p.state === "open" && now > p.deadlineUnix && p.solutions.length > 0,
  );
  if (candidates.length === 0) {
    bumpCount("settle", "no_eligible");
    return;
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];

  // Build winner allocation: pick the most-voted solution as winner;
  // ties broken by earliest commit (already preserved by push order).
  const voteCount = new Map<string, number>();
  for (const v of target.votes) {
    voteCount.set(v.forSolutionLabel, (voteCount.get(v.forSolutionLabel) ?? 0) + 1);
  }
  let winnerSol = target.solutions[0];
  let bestVotes = voteCount.get(winnerSol.authorLabel) ?? 0;
  for (const s of target.solutions.slice(1)) {
    const vc = voteCount.get(s.authorLabel) ?? 0;
    if (vc > bestVotes) {
      winnerSol = s;
      bestVotes = vc;
    }
  }

  // Read pool balance from chain (slashed bonds will be added by Router).
  const qState = (await pub.readContract({
    address: ROUTER, abi: ROUTER_V2_ABI, functionName: "questions", args: [target.qid],
  })) as [number, Address, number, bigint, bigint];
  const poolBefore = qState[3];

  // Slash logic: every solution NOT the winner gets slashed; every
  // vote NOT for the winner gets slashed.
  const slashCommit: Hex[] = [];
  const slashVote: Hex[] = [];
  for (const s of target.solutions) {
    if (s.authorLabel !== winnerSol.authorLabel) {
      slashCommit.push(s.intentHash);
      s.slashed = true;
    }
  }
  for (const v of target.votes) {
    if (v.forSolutionLabel !== winnerSol.authorLabel) {
      slashVote.push(v.intentHash);
      v.slashed = true;
    }
  }

  const slashedBondTotal =
    target.solutions.filter((s) => s.slashed).reduce((sum, s) => sum + s.bondWei, 0n) +
    target.votes.filter((v) => v.slashed).reduce((sum, v) => sum + v.bondWei, 0n);
  const expandedPool = poolBefore + slashedBondTotal;
  const feeAmt = (expandedPool * PLATFORM_FEE_BPS) / 10000n;
  const winnerAmt = expandedPool - feeAmt;

  // Find winner's wallet address. winnerSol.authorLabel is one of a/b/c/d.
  const winnerAgent = AGENTS_BY_LABEL.get(winnerSol.authorLabel)!;

  const leaves: MerkleLeaf[] = [
    { questionId: target.qid, recipient: winnerAgent.address, amount: winnerAmt },
    { questionId: target.qid, recipient: feeWallet.address, amount: feeAmt },
  ];
  const leafHashes = leaves.map(hashLeaf);
  const root = merkleRoot(leaves);

  const settleTd = buildSettlementIntentTypedData({
    routerAddress: ROUTER, chainId: CHAIN_ID, questionId: target.qid,
    merkleRoot: root, slashedCommitHashes: slashCommit, slashedVoteHashes: slashVote,
    expiresAtSeconds: now + DEFAULT_SETTLEMENT_TTL_SECONDS,
  });
  const oracleSig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(settleTd)) as Hex;

  try {
    const tx = await broadcastPublishSettlement(agent.walletClient, {
      routerAddress: ROUTER, questionId: target.qid, merkleRoot: root,
      expiresAt: settleTd.message.expiresAt,
      slashedCommitHashes: slashCommit, slashedVoteHashes: slashVote, oracleSig,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `settled ${target.id.slice(0, 14)}… winner=${winnerSol.authorLabel} pool=${fmtUsdc(expandedPool)} (slashed +${fmtUsdc(slashedBondTotal)})`);
    target.state = "settled";
    target.winnerLabel = winnerSol.authorLabel;
    target.merkleLeaves = leaves;
    target.leafByRecipient = new Map(leaves.map((l) => [l.recipient, l]));
    target.poolWei = expandedPool;
    target.feeWei = feeAmt;
    target.winnerAmountWei = winnerAmt;
    target.claimedRecipients = new Set();
    bumpCount("settle", "ok");
  } catch (e) {
    fail(tick, agent.label, `publishSettlement revert: ${(e as Error).message.slice(0, 100)}`);
    bumpCount("settle", "fail_chain");
    anomalies.push({ tick, kind: "settle_revert", detail: (e as Error).message.slice(0, 200) });
  }
}

// ─── Action: claim_pool (winner or fee wallet) ─────────────────────

async function actClaim(
  tick: number,
  agent: Agent,
  feeWallet: { address: Address; walletClient: ReturnType<typeof makeAgentWalletClient> },
  pub: ReturnType<typeof createPublicClient>,
) {
  // Find a settled problem where this agent has an unclaimed leaf.
  const candidates: { p: Problem; leaf: MerkleLeaf; recipient: Address; clientWallet: ReturnType<typeof makeAgentWalletClient> }[] = [];
  for (const p of problems.values()) {
    if (p.state !== "settled" || !p.leafByRecipient || !p.claimedRecipients) continue;
    if (p.leafByRecipient.has(agent.address) && !p.claimedRecipients.has(agent.address)) {
      candidates.push({ p, leaf: p.leafByRecipient.get(agent.address)!, recipient: agent.address, clientWallet: agent.walletClient });
    }
    // Also let agent a (acting as oracle/operator) claim fee_wallet's leaf opportunistically.
    if (
      agent.label === "a" &&
      p.leafByRecipient.has(feeWallet.address) &&
      !p.claimedRecipients.has(feeWallet.address)
    ) {
      candidates.push({
        p, leaf: p.leafByRecipient.get(feeWallet.address)!,
        recipient: feeWallet.address, clientWallet: feeWallet.walletClient,
      });
    }
  }
  if (candidates.length === 0) {
    bumpCount("claim_pool", "no_eligible");
    return;
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const leafIdx = pick.p.merkleLeaves!.findIndex((l) => l.recipient === pick.leaf.recipient);
  const proof = merkleProof(pick.p.merkleLeaves!.map(hashLeaf), leafIdx);

  try {
    const tx = await broadcastClaim(pick.clientWallet, {
      routerAddress: ROUTER, questionId: pick.p.qid, amount: pick.leaf.amount, proof,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `claimed ${fmtUsdc(pick.leaf.amount)} from ${pick.p.id.slice(0, 14)}… for ${pick.recipient.slice(0, 8)}…`);
    pick.p.claimedRecipients!.add(pick.recipient);
    if (pick.p.claimedRecipients!.size === pick.p.merkleLeaves!.length) {
      pick.p.state = "drained";
    }
    bumpCount("claim_pool", "ok");
  } catch (e) {
    fail(tick, agent.label, `claim revert: ${(e as Error).message.slice(0, 100)}`);
    bumpCount("claim_pool", "fail_chain");
    anomalies.push({ tick, kind: "claim_revert", detail: (e as Error).message.slice(0, 200) });
  }
}

// ─── Action: claim_solution_bond / claim_vote_bond ─────────────────

async function actClaimBond(tick: number, agent: Agent, pub: ReturnType<typeof createPublicClient>) {
  // Find a settled problem where this agent is a non-slashed bond holder.
  const opts: { p: Problem; intentHash: Hex; isVote: boolean; amount: bigint }[] = [];
  for (const p of problems.values()) {
    if (p.state !== "settled" && p.state !== "drained") continue;
    for (const s of p.solutions) {
      if (s.authorLabel === agent.label && !s.slashed && !s.bondClaimed) {
        opts.push({ p, intentHash: s.intentHash, isVote: false, amount: s.bondWei });
      }
    }
    for (const v of p.votes) {
      if (v.voterLabel === agent.label && !v.slashed && !v.bondClaimed) {
        opts.push({ p, intentHash: v.intentHash, isVote: true, amount: v.bondWei });
      }
    }
  }
  if (opts.length === 0) {
    bumpCount("claim_bond", "no_eligible");
    return;
  }
  const pick = opts[Math.floor(Math.random() * opts.length)];
  const fnName = pick.isVote ? "claimVoteBond" : "claimSolutionBond";

  try {
    const tx = await agent.walletClient.writeContract({
      address: ROUTER, abi: ROUTER_V2_ABI, functionName: fnName,
      args: [pick.p.qid, pick.intentHash],
      account: agent.walletClient.account!, chain: agent.walletClient.chain,
    });
    await awaitReceipt(pub, tx);
    ok(tick, agent.label, `${fnName} ${fmtUsdc(pick.amount)} from ${pick.p.id.slice(0, 14)}…`);
    if (pick.isVote) {
      pick.p.votes.find((v) => v.intentHash === pick.intentHash)!.bondClaimed = true;
    } else {
      pick.p.solutions.find((s) => s.intentHash === pick.intentHash)!.bondClaimed = true;
    }
    bumpCount(`claim_bond_${pick.isVote ? "vote" : "soln"}`, "ok");
  } catch (e) {
    fail(tick, agent.label, `${fnName} revert: ${(e as Error).message.slice(0, 100)}`);
    bumpCount(`claim_bond_${pick.isVote ? "vote" : "soln"}`, "fail_chain");
    anomalies.push({ tick, kind: "bond_claim_revert", detail: (e as Error).message.slice(0, 200) });
  }
}

// ─── Sybil probe: double_commit ────────────────────────────────────

async function probeDoubleCommit(tick: number, agent: Agent, pub: ReturnType<typeof createPublicClient>) {
  const own = Array.from(problems.values()).find(
    (p) => p.state === "open" && p.solutions.some((s) => s.authorLabel === agent.label),
  );
  if (!own) {
    bumpCount("sybil_double_commit", "no_eligible");
    return;
  }
  log(tick, agent.label, `${c.magenta("PROBE")} double-commit on ${own.id.slice(0, 14)}…`);
  // Try to commit again on same problem — should fail intent_hash uniqueness
  // OR (since bytes will differ — different content) succeed with a 2nd commit.
  // Either is permitted by R-CHAIN-IS-AUTHORITY; we just want to observe.
  const pre = await call<CommitPreflight>(
    "GET", `/v1/problems/${own.id}/commit/preflight?submitter=${agent.address}`,
  );
  if (!pre.ok) {
    note(tick, agent.label, `2nd-commit preflight: ${pre.errCode}`);
    bumpCount("sybil_double_commit", `pre_${pre.errCode}`);
    return;
  }
  const body = `2nd solution from ${agent.label} at t${tick}`;
  const td = buildCommitIntentTypedData({
    preflight: pre.data, submitter: agent.address, contentHash: computeContentHash(body),
  });
  const sig = (await privateKeyToAccount(agent.wallet.privateKey).signTypedData(td)) as Hex;
  const intent = await call<{ intent_hash: string }>(
    "POST", `/v1/problems/${own.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: td, signature: sig }),
    agent.token,
  );
  if (!intent.ok) {
    note(tick, agent.label, `2nd-commit intent: ${intent.errCode} (expected backend gate)`);
    bumpCount("sybil_double_commit", `intent_${intent.errCode}`);
    anomalies.push({ tick, kind: "double_commit_blocked_at_intent", detail: intent.errCode ?? "" });
    return;
  }
  // If the backend allowed it, we'd see a 2nd commit. But we're just
  // probing — don't actually broadcast (would consume bond).
  note(tick, agent.label, `2nd-commit intent ACCEPTED at backend (intent_hash=${intent.data.intent_hash.slice(0, 14)}…)`);
  bumpCount("sybil_double_commit", "intent_accepted");
  anomalies.push({ tick, kind: "double_commit_intent_accepted", detail: `${agent.label} got 2nd intent_hash on ${own.id}` });
}

// ─── Picker ────────────────────────────────────────────────────────

async function pickAction(tick: number, agent: Agent): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const open = Array.from(problems.values()).filter((p) => p.state === "open");
  const openWithSols = open.filter((p) => p.solutions.length > 0);
  const settleReady = open.filter((p) => now > p.deadlineUnix && p.solutions.length > 0);
  const claimReady = Array.from(problems.values()).filter(
    (p) => p.state === "settled" && p.claimedRecipients && p.claimedRecipients.size < (p.merkleLeaves?.length ?? 0),
  );
  const bondClaimReady = Array.from(problems.values()).filter((p) => {
    if (p.state !== "settled" && p.state !== "drained") return false;
    return p.solutions.some((s) => s.authorLabel === agent.label && !s.slashed && !s.bondClaimed) ||
      p.votes.some((v) => v.voterLabel === agent.label && !v.slashed && !v.bondClaimed);
  });

  const actions: { name: string; weight: number }[] = [
    { name: "create", weight: open.length < 4 ? 4 : 1 },
    { name: "commit", weight: open.length > 0 ? 4 : 0 },
    { name: "vote", weight: openWithSols.length > 0 ? 4 : 0 },
    { name: "settle", weight: settleReady.length > 0 && agent.label === "a" ? 8 : 0 }, // oracle-only
    { name: "claim_pool", weight: claimReady.length > 0 ? 6 : 0 },
    { name: "claim_bond", weight: bondClaimReady.length > 0 ? 4 : 0 },
  ];
  // Inject a Sybil probe at tick 8 once activity has warmed up.
  if (tick === 8) actions.push({ name: "sybil_double_commit", weight: 999 });

  const total = actions.reduce((s, a) => s + a.weight, 0);
  if (total === 0) return "idle";
  let r = Math.random() * total;
  for (const a of actions) {
    r -= a.weight;
    if (r <= 0) return a.name;
  }
  return actions[0].name;
}

// ─── Globals ───────────────────────────────────────────────────────

const AGENTS_BY_LABEL = new Map<string, Agent>();

async function main() {
  console.log(c.bold(`swarm-full — ${TICKS} ticks against router ${ROUTER}`));

  const wallets = [0, 1, 2, 4].map((n) => deriveAgentWallet(MNEMONIC!, n, CHAIN_ID));
  const labels = ["a", "b", "c", "d"];
  const agents: Agent[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const auth = await login(w);
    const a: Agent = {
      label: labels[i], wallet: w, address: auth.address, token: auth.token,
      walletClient: makeAgentWalletClient({
        privateKey: w.privateKey, chainId: CHAIN_ID, rpcUrl: RPC,
      }),
    };
    agents.push(a);
    AGENTS_BY_LABEL.set(a.label, a);
  }
  // fee_wallet at path 3 — receives platform fee leaves.
  const feeWallet = deriveAgentWallet(MNEMONIC!, 3, CHAIN_ID);
  const feeWalletClient = makeAgentWalletClient({
    privateKey: feeWallet.privateKey, chainId: CHAIN_ID, rpcUrl: RPC,
  });

  const pub = createPublicClient({ transport: http(RPC) });

  const startBals = new Map<string, bigint>();
  for (const a of agents) startBals.set(a.label, await balance(pub, a.address));
  startBals.set("fee", await balance(pub, feeWallet.address));
  console.log(c.bold("\nStarting balances:"));
  for (const a of agents) console.log(`  ${a.label}    ${fmtUsdc(startBals.get(a.label)!)} USDC`);
  console.log(`  fee  ${fmtUsdc(startBals.get("fee")!)} USDC`);
  console.log("");

  for (let tick = 1; tick <= TICKS; tick++) {
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const action = await pickAction(tick, agent);
    log(tick, c.blue(agent.label), `→ ${c.bold(action)}`);
    try {
      switch (action) {
        case "create": await actCreate(tick, agent, pub); break;
        case "commit": await actCommit(tick, agent, pub); break;
        case "vote": await actVote(tick, agent, pub); break;
        case "settle": await actSettle(tick, agent, feeWallet, pub); break;
        case "claim_pool":
          await actClaim(tick, agent, { address: feeWallet.address, walletClient: feeWalletClient }, pub);
          break;
        case "claim_bond": await actClaimBond(tick, agent, pub); break;
        case "sybil_double_commit": await probeDoubleCommit(tick, agent, pub); break;
        case "idle": note(tick, agent.label, "no action available"); break;
      }
    } catch (e) {
      fail(tick, agent.label, `unhandled: ${(e as Error).message.slice(0, 200)}`);
      anomalies.push({ tick, kind: "unhandled", detail: (e as Error).message.slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, MIN_SLEEP_MS + Math.random() * (MAX_SLEEP_MS - MIN_SLEEP_MS)));
  }

  // Final report.
  await new Promise((r) => setTimeout(r, 4000));
  console.log("");
  console.log(c.bold(c.magenta("━━━━━━━━━━ Final balances ━━━━━━━━━━")));
  for (const a of agents) {
    const end = await balance(pub, a.address);
    const delta = end - startBals.get(a.label)!;
    console.log(`  ${a.label}    end ${fmtUsdc(end).padStart(12)}    Δ ${fmtUsdc(delta).padStart(12)}`);
  }
  const feeEnd = await balance(pub, feeWallet.address);
  const feeDelta = feeEnd - startBals.get("fee")!;
  console.log(`  fee   end ${fmtUsdc(feeEnd).padStart(12)}    Δ ${fmtUsdc(feeDelta).padStart(12)}`);

  const routerEnd = await balance(pub, ROUTER);
  console.log(`  Router    ${fmtUsdc(routerEnd).padStart(12)}  (still locked)`);

  console.log(c.bold(c.magenta("\n━━━━━━━━━━ Action counts ━━━━━━━━━━")));
  for (const k of Object.keys(counts).sort()) {
    console.log(`  ${k.padEnd(45)} ${counts[k]}`);
  }

  console.log(c.bold(c.magenta("\n━━━━━━━━━━ Problem outcomes ━━━━━━━━━━")));
  const byState: Record<string, number> = { open: 0, settled: 0, drained: 0, expired: 0 };
  for (const p of problems.values()) {
    byState[p.state] = (byState[p.state] ?? 0) + 1;
    console.log(
      `  ${p.id.slice(0, 22)}…  state=${p.state.padEnd(8)}  funder=${p.funderLabel}  solns=${p.solutions.length}  votes=${p.votes.length}  winner=${p.winnerLabel ?? "-"}`,
    );
  }
  console.log(`  states: ${Object.entries(byState).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  console.log(c.bold(c.magenta("\n━━━━━━━━━━ Anomalies ━━━━━━━━━━")));
  if (anomalies.length === 0) console.log("  (none)");
  else for (const a of anomalies) console.log(`  [${a.tick.toString().padStart(2)}] ${c.yellow(a.kind)} — ${a.detail.slice(0, 200)}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n\x1b[31m[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
