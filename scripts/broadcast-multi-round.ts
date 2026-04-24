#!/usr/bin/env tsx
// broadcast-multi-round.ts — 3 problems, rotating roles.
//
// Every one of 4 agents plays every role exactly once across 3 rounds:
//
//   | Round | Funder | Winner-solver | Loser-solver | Correct-voter |
//   |-------|--------|---------------|--------------|---------------|
//   | P1    | a      | b             | c            | d             |
//   | P2    | b      | c             | d            | a             |
//   | P3    | c      | d             | a            | b             |
//
// Agent a (= w0) is also the protocol oracle in every round — the
// Router's `oracle` storage slot is set at deploy and only that key
// can sign publishSettlement. Multi-role overlap on w0 is fine; the
// signatures are over different EIP-712 types.
//
// Expected per-agent cumulative (with 1 USDC fund + 1 slashed commit
// bond per round, 10% fee):
//
//   expanded_pool = fund + slashed_bond  (= 2 USDC at 1 USDC bond)
//   winnerAmt     = expanded_pool × 0.9
//   feeAmt        = expanded_pool × 0.1
//
//   a: -1 (P1 fund) + 0 (P2 voter) - 1 (P3 loser)   = -2
//   b: +winnerAmt (P1)              - 1 (P2 fund) + 0 (P3 voter) = winnerAmt - 1
//   c: -1 (P1 loser)                + winnerAmt (P2) - 1 (P3 fund) = winnerAmt - 2
//   d: 0 (P1 voter)                 - 1 (P2 loser) + winnerAmt (P3) = winnerAmt - 1
//   fee: +3 × feeAmt
//
// Sum across all = 0 (conservation).
//
// Final output is a ledger table — per-agent starting balance,
// per-round deltas, end balance — plus strict invariant asserts.

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
const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROUTER = process.env.RT_ROUTER_ADDRESS as Address | undefined;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!ROUTER) throw new Error("RT_ROUTER_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const PLATFORM_FEE_BPS = BigInt(process.env.RT_PLATFORM_FEE_BPS ?? "1000");

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};
const log = (s: string, d?: string) =>
  console.log(`${c.cyan(`[${s}]`)}${d ? ` ${d}` : ""}`);
const ok = (d: string) => console.log(`  ${c.green("✓")} ${d}`);
const info = (d: string) => console.log(`  ${c.dim(d)}`);
const warn = (d: string) => console.log(`  ${c.yellow("!")} ${d}`);
const fail = (d: string) => console.log(`  ${c.red("✗")} ${d}`);

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
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
    const err = (parsed as { error?: { message?: string; action?: string } }).error;
    throw new Error(
      `${method} ${path} → ${res.status}: ${err?.message ?? raw}${err?.action ? ` — ${err.action}` : ""}`,
    );
  }
  return parsed as T;
}

interface Agent {
  label: string;
  wallet: AgentWallet;
  address: Address;
  token: string;
  walletClient: ReturnType<typeof makeAgentWalletClient>;
}

async function loginAgent(label: string, wallet: AgentWallet): Promise<Agent> {
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain: loadLoginDomain(),
  });
  const r = await call<{ access_token: string; address: Address }>(
    "POST",
    "/auth/wallet",
    body,
  );
  return {
    label,
    wallet,
    address: r.address,
    token: r.access_token,
    walletClient: makeAgentWalletClient({
      privateKey: wallet.privateKey,
      chainId: CHAIN_ID,
      rpcUrl: RPC,
    }),
  };
}

interface RoundPlan {
  idx: number;
  funder: Agent;
  winner: Agent;
  loser: Agent;
  voter: Agent;
}

interface RoundResult {
  idx: number;
  qid: Hex;
  problemId: string;
  poolBefore: bigint;
  expandedPool: bigint;
  winnerAmount: bigint;
  feeAmount: bigint;
  winnerCommitBond: bigint;
  loserCommitBond: bigint;
  voterBond: bigint;
  fundAmount: bigint;
}

interface RoundCtx {
  publicClient: ReturnType<typeof createPublicClient>;
  oracle: Agent; // always w0 / agent[0]
  feeWallet: AgentWallet;
  feeWalletClient: ReturnType<typeof makeAgentWalletClient>;
}

async function runRound(plan: RoundPlan, ctx: RoundCtx): Promise<RoundResult> {
  const { idx, funder, winner, loser, voter } = plan;
  const { publicClient, oracle, feeWallet, feeWalletClient } = ctx;

  console.log("");
  console.log(c.magenta(c.bold(`━━━ Round ${idx} ━━━`)));
  console.log(c.dim(
    `  funder=${funder.label}  winner=${winner.label}  loser=${loser.label}  voter=${voter.label}`,
  ));

  // Create problem (funder authors the question).
  const problem = await call<{
    id: string;
    success_criteria: { id: string }[];
  }>(
    "POST",
    "/v1/problems",
    {
      title: `Multi-round P${idx} by ${funder.label} ${Date.now()}`,
      description: `Round ${idx}. ${funder.label} asks; ${winner.label} and ${loser.label} solve; ${voter.label} votes for ${winner.label}.`,
      success_criteria: [
        { name: "primary", type: "boolean", target: "true", weight: 100 },
      ],
      initial_bounty: "0",
    },
    funder.token,
  );
  ok(`problem ${problem.id}`);

  // ── FUND ────────────────────────────────────────────────────────
  const fundPre = await call<FundPreflight>(
    "GET",
    `/v1/problems/${problem.id}/fund/preflight?funder=${funder.address}`,
  );
  const fundAmount = parseAmountToWei("1", fundPre.token.decimals);
  const fundTd = buildFundIntentTypedData({
    preflight: fundPre,
    funder: funder.address,
    amountWei: fundAmount,
  });
  const fundSig = (await privateKeyToAccount(funder.wallet.privateKey).signTypedData(fundTd)) as Hex;
  await call(
    "POST",
    `/v1/problems/${problem.id}/fund`,
    buildFundRequestBody({ typedData: fundTd, signature: fundSig }),
    funder.token,
  );
  const qid = fundTd.message.questionId;
  const fundPermit = await signUSDCPermit(funder.walletClient, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: fundAmount,
    deadline: fundTd.message.expiresAt,
  });
  const fundTx = await broadcastFund(funder.walletClient, {
    routerAddress: ROUTER!,
    intent: fundTd.message,
    intentSig: fundSig,
    permit: fundPermit,
  });
  await awaitReceipt(publicClient, fundTx);
  info(`${funder.label} funded ${fmtUsdc(fundAmount)} (tx ${fundTx.slice(0, 14)}…)`);

  // ── COMMIT winner ───────────────────────────────────────────────
  const winnerCommit = await commitOne({
    problem,
    solver: winner,
    publicClient,
    body: `Round ${idx}: ${winner.label}'s winning solution.`,
  });
  info(`${winner.label} committed (winner)  ${winnerCommit.intentHash.slice(0, 14)}…`);

  // ── COMMIT loser ────────────────────────────────────────────────
  const loserCommit = await commitOne({
    problem,
    solver: loser,
    publicClient,
    body: `Round ${idx}: ${loser.label}'s losing solution.`,
  });
  info(`${loser.label} committed (loser)   ${loserCommit.intentHash.slice(0, 14)}…`);

  // ── VOTE voter (for winner) ─────────────────────────────────────
  const vote = await voteOne({
    problem,
    voter,
    publicClient,
    allocations: [{ solution_id: winnerCommit.solutionId, points: 100 }],
  });
  info(`${voter.label} voted for ${winner.label}  ${vote.intentHash.slice(0, 14)}…`);

  // ── SETTLE ─────────────────────────────────────────────────────
  const qState = (await publicClient.readContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "questions",
    args: [qid],
  })) as [number, Address, number, bigint, bigint];
  const poolBefore = qState[3];
  const expandedPool = poolBefore + loserCommit.bond;
  const feeAmount = (expandedPool * PLATFORM_FEE_BPS) / 10000n;
  const winnerAmount = expandedPool - feeAmount;

  const leaves: MerkleLeaf[] = [
    { questionId: qid, recipient: winner.address, amount: winnerAmount },
    { questionId: qid, recipient: feeWallet.address, amount: feeAmount },
  ];
  const leafHashes = leaves.map(hashLeaf);
  const root = merkleRoot(leaves);
  const winnerProof = merkleProof(leafHashes, 0);
  const feeProof = merkleProof(leafHashes, 1);

  const settleTd = buildSettlementIntentTypedData({
    routerAddress: ROUTER!,
    chainId: CHAIN_ID,
    questionId: qid,
    merkleRoot: root,
    slashedCommitHashes: [loserCommit.intentHash],
    slashedVoteHashes: [],
    expiresAtSeconds: Math.floor(Date.now() / 1000) + DEFAULT_SETTLEMENT_TTL_SECONDS,
  });
  const oracleSig = (await privateKeyToAccount(oracle.wallet.privateKey).signTypedData(settleTd)) as Hex;
  const settleTx = await broadcastPublishSettlement(oracle.walletClient, {
    routerAddress: ROUTER!,
    questionId: qid,
    merkleRoot: root,
    expiresAt: settleTd.message.expiresAt,
    slashedCommitHashes: [loserCommit.intentHash],
    slashedVoteHashes: [],
    oracleSig,
  });
  await awaitReceipt(publicClient, settleTx);
  info(
    `settled: pool ${fmtUsdc(poolBefore)} → ${fmtUsdc(expandedPool)} (slashed +${fmtUsdc(loserCommit.bond)}); winner=${fmtUsdc(winnerAmount)}, fee=${fmtUsdc(feeAmount)}`,
  );
  await new Promise((r) => setTimeout(r, 4000)); // RPC lag

  // ── CLAIM winner pool leaf ─────────────────────────────────────
  const winnerClaimTx = await broadcastClaim(winner.walletClient, {
    routerAddress: ROUTER!,
    questionId: qid,
    amount: winnerAmount,
    proof: winnerProof,
  });
  await awaitReceipt(publicClient, winnerClaimTx);

  // ── CLAIM fee leaf ─────────────────────────────────────────────
  const feeClaimTx = await broadcastClaim(feeWalletClient, {
    routerAddress: ROUTER!,
    questionId: qid,
    amount: feeAmount,
    proof: feeProof,
  });
  await awaitReceipt(publicClient, feeClaimTx);

  // ── CLAIM winner's commit bond ─────────────────────────────────
  const winnerBondTx = await winner.walletClient.writeContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "claimSolutionBond",
    args: [qid, winnerCommit.intentHash],
    account: winner.walletClient.account!,
    chain: winner.walletClient.chain,
  });
  await awaitReceipt(publicClient, winnerBondTx);

  // ── CLAIM voter's vote bond ────────────────────────────────────
  const voterBondTx = await voter.walletClient.writeContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "claimVoteBond",
    args: [qid, vote.intentHash],
    account: voter.walletClient.account!,
    chain: voter.walletClient.chain,
  });
  await awaitReceipt(publicClient, voterBondTx);
  ok(
    `claims done: ${winner.label}+pool ${fmtUsdc(winnerAmount)}, ` +
      `fee_wallet+fee ${fmtUsdc(feeAmount)}, ` +
      `${winner.label}+bond ${fmtUsdc(winnerCommit.bond)}, ` +
      `${voter.label}+bond ${fmtUsdc(vote.bond)}`,
  );

  return {
    idx,
    qid,
    problemId: problem.id,
    poolBefore,
    expandedPool,
    winnerAmount,
    feeAmount,
    winnerCommitBond: winnerCommit.bond,
    loserCommitBond: loserCommit.bond,
    voterBond: vote.bond,
    fundAmount,
  };
}

async function commitOne(params: {
  problem: { id: string; success_criteria: { id: string }[] };
  solver: Agent;
  publicClient: ReturnType<typeof createPublicClient>;
  body: string;
}): Promise<{ solutionId: string; intentHash: Hex; bond: bigint }> {
  const { problem, solver, publicClient, body } = params;
  const pre = await call<CommitPreflight>(
    "GET",
    `/v1/problems/${problem.id}/commit/preflight?submitter=${solver.address}`,
  );
  const contentHash = computeContentHash(body);
  const td = buildCommitIntentTypedData({
    preflight: pre,
    submitter: solver.address,
    contentHash,
  });
  const sig = (await privateKeyToAccount(solver.wallet.privateKey).signTypedData(td)) as Hex;
  const resp = await call<{ intent_hash: string }>(
    "POST",
    `/v1/problems/${problem.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: td, signature: sig }),
    solver.token,
  );
  const solution = await call<{ id: string }>(
    "POST",
    `/v1/problems/${problem.id}/solutions`,
    {
      intent_hash: resp.intent_hash,
      summary: body,
      reasoning_tree: [{ because: "Rotating-roles demo.", therefore: "Each agent plays every role." }],
      claims: [
        {
          criterion_id: problem.success_criteria[0].id,
          value: true,
          argument: "By construction.",
          falsifiable_by: "Demo-only.",
        },
      ],
    },
    solver.token,
  );
  const bond = BigInt(td.message.bondAmount);
  const fee = BigInt(td.message.feeAmount);
  const permit = await signUSDCPermit(solver.walletClient, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: fee + bond,
    deadline: td.message.expiresAt,
  });
  const tx = await broadcastCommit(solver.walletClient, {
    routerAddress: ROUTER!,
    intent: td.message,
    intentSig: sig,
    permit,
  });
  await awaitReceipt(publicClient, tx);
  return { solutionId: solution.id, intentHash: resp.intent_hash as Hex, bond };
}

async function voteOne(params: {
  problem: { id: string };
  voter: Agent;
  publicClient: ReturnType<typeof createPublicClient>;
  allocations: Allocation[];
}): Promise<{ intentHash: Hex; bond: bigint }> {
  const { problem, voter, publicClient, allocations } = params;
  const pre = await call<VotePreflight>(
    "GET",
    `/v1/problems/${problem.id}/vote/preflight?voter=${voter.address}`,
  );
  const allocationsHash = computeAllocationsHash(allocations);
  const td = buildVoteIntentTypedData({
    preflight: pre,
    voter: voter.address,
    allocationsHash,
  });
  const sig = (await privateKeyToAccount(voter.wallet.privateKey).signTypedData(td)) as Hex;
  const resp = await call<{ intent_hash: string }>(
    "POST",
    `/v1/problems/${problem.id}/vote-intent`,
    buildSubmitVoteIntentRequestBody({
      typedData: td,
      allocations,
      signature: sig,
    }),
    voter.token,
  );
  const bond = BigInt(td.message.bondAmount);
  const fee = BigInt(td.message.feeAmount);
  const permit = await signUSDCPermit(voter.walletClient, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: fee + bond,
    deadline: td.message.expiresAt,
  });
  const tx = await broadcastVote(voter.walletClient, {
    routerAddress: ROUTER!,
    intent: td.message,
    intentSig: sig,
    permit,
  });
  await awaitReceipt(publicClient, tx);
  return { intentHash: resp.intent_hash as Hex, bond };
}

async function readBalance(
  publicClient: ReturnType<typeof createPublicClient>,
  address: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC,
    abi: ERC20,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

async function ensureFunded(
  from: ReturnType<typeof makeAgentWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  to: Address,
  label: string,
  minWei: bigint,
  topupWei: bigint,
): Promise<bigint> {
  const bal = await readBalance(publicClient, to);
  if (bal >= minWei) {
    info(`${label} ${to.slice(0, 10)}… has ${fmtUsdc(bal)} ≥ ${fmtUsdc(minWei)}`);
    return 0n;
  }
  warn(`${label} ${to.slice(0, 10)}… has ${fmtUsdc(bal)} < ${fmtUsdc(minWei)}; topping up ${fmtUsdc(topupWei)}`);
  const tx = await from.writeContract({
    address: USDC,
    abi: ERC20,
    functionName: "transfer",
    args: [to, topupWei],
    account: from.account!,
    chain: from.chain,
  });
  await awaitReceipt(publicClient, tx);
  return topupWei;
}

async function main() {
  log("multi-round", c.bold(`backend ${BACKEND} | router ${ROUTER}`));

  // Derive 4 agents + fee_wallet. Paths chosen to not collide with
  // broadcast-multi-party's w3/w4 (N=4,5) — here we need a N=4 for
  // agent d; the overlap is intentional + harmless (same wallet).
  const walletA = deriveAgentWallet(MNEMONIC!, 0, CHAIN_ID); // w0 (also oracle)
  const walletB = deriveAgentWallet(MNEMONIC!, 1, CHAIN_ID);
  const walletC = deriveAgentWallet(MNEMONIC!, 2, CHAIN_ID);
  const walletD = deriveAgentWallet(MNEMONIC!, 4, CHAIN_ID);
  const feeWallet = deriveAgentWallet(MNEMONIC!, 3, CHAIN_ID);

  log("login");
  const [a, b, cAgent, d] = await Promise.all([
    loginAgent("a", walletA),
    loginAgent("b", walletB),
    loginAgent("c", walletC),
    loginAgent("d", walletD),
  ]);
  ok("4 JWTs acquired");

  const feeWalletClient = makeAgentWalletClient({
    privateKey: feeWallet.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const publicClient = createPublicClient({ transport: http(RPC) });

  const agents = [a, b, cAgent, d];

  // ── Pre-flight: top up each agent from a if needed ──────────────
  // Per-agent max out-of-pocket across all 3 rounds:
  //   funds once (1), loses bond once (1), votes once (1 locked,
  //   refunded same round). So ~2.5 USDC balance is enough. We use
  //   3 USDC as the minimum floor, topping up to 4 USDC when short.
  log("ensure agents funded");
  const topupTotals = new Map<Address, bigint>();
  for (const g of [b, cAgent, d]) {
    const topup = await ensureFunded(
      a.walletClient,
      publicClient,
      g.address,
      g.label,
      3_000_000n,
      4_000_000n,
    );
    if (topup > 0n) topupTotals.set(g.address, topup);
  }

  // ── Record starting balances (after topups) ─────────────────────
  const startBals = new Map<Address, bigint>();
  for (const g of agents) startBals.set(g.address, await readBalance(publicClient, g.address));
  startBals.set(feeWallet.address, await readBalance(publicClient, feeWallet.address));
  const startRouter = await readBalance(publicClient, ROUTER!);

  console.log("");
  console.log(c.bold("── Starting balance sheet (post-topups) ──"));
  for (const g of agents)
    console.log(`  ${g.label}           ${g.address} ${fmtUsdc(startBals.get(g.address)!).padStart(12)}`);
  console.log(`  fee_wallet    ${feeWallet.address} ${fmtUsdc(startBals.get(feeWallet.address)!).padStart(12)}`);
  console.log(`  Router        ${ROUTER}                                ${fmtUsdc(startRouter).padStart(12)}`);

  // ── Build rotating schedule ─────────────────────────────────────
  const rounds: RoundPlan[] = [
    { idx: 1, funder: a, winner: b, loser: cAgent, voter: d },
    { idx: 2, funder: b, winner: cAgent, loser: d, voter: a },
    { idx: 3, funder: cAgent, winner: d, loser: a, voter: b },
  ];

  const ctx: RoundCtx = {
    publicClient,
    oracle: a, // w0 is the protocol oracle
    feeWallet,
    feeWalletClient,
  };

  // ── Run all rounds sequentially ────────────────────────────────
  const results: RoundResult[] = [];
  for (const plan of rounds) {
    const result = await runRound(plan, ctx);
    results.push(result);
  }

  // ── Collect final balances ─────────────────────────────────────
  await new Promise((r) => setTimeout(r, 3000)); // RPC lag settle
  const endBals = new Map<Address, bigint>();
  for (const g of agents) endBals.set(g.address, await readBalance(publicClient, g.address));
  endBals.set(feeWallet.address, await readBalance(publicClient, feeWallet.address));
  const endRouter = await readBalance(publicClient, ROUTER!);

  // ── Per-agent ledger ────────────────────────────────────────────
  // Each agent's role per round drives the expected delta.
  interface RoleDelta {
    round: number;
    role: string;
    delta: bigint;
    explanation: string;
  }

  const ledger = new Map<Address, RoleDelta[]>();
  for (const g of agents) ledger.set(g.address, []);
  ledger.set(feeWallet.address, []);

  for (const r of results) {
    const plan = rounds[r.idx - 1];
    // funder
    ledger.get(plan.funder.address)!.push({
      round: r.idx,
      role: "funder",
      delta: -r.fundAmount,
      explanation: `bounty -${fmtUsdc(r.fundAmount)}`,
    });
    // winner: -bond (posted) + pool + bond (refunded) = pool net
    ledger.get(plan.winner.address)!.push({
      round: r.idx,
      role: "winner",
      delta: r.winnerAmount,
      explanation: `pool +${fmtUsdc(r.winnerAmount)} (bond posted & refunded cancel)`,
    });
    // loser: -bond (slashed, no refund)
    ledger.get(plan.loser.address)!.push({
      round: r.idx,
      role: "loser",
      delta: -r.loserCommitBond,
      explanation: `commit bond SLASHED -${fmtUsdc(r.loserCommitBond)}`,
    });
    // voter: -bond + bond = 0
    ledger.get(plan.voter.address)!.push({
      round: r.idx,
      role: "voter",
      delta: 0n,
      explanation: "bond posted & refunded",
    });
    // fee wallet
    ledger.get(feeWallet.address)!.push({
      round: r.idx,
      role: "fee_collector",
      delta: r.feeAmount,
      explanation: `platform cut +${fmtUsdc(r.feeAmount)}`,
    });
  }

  console.log("");
  console.log(c.bold("━━━━━━━━━━━━━━━━━━━━━━━━━━ Per-agent ledger ━━━━━━━━━━━━━━━━━━━━━━━━━━"));

  let allAgentsExpectedSum = 0n;
  let allAgentsActualSum = 0n;
  let invariantsFailed = false;

  for (const g of agents) {
    const entries = ledger.get(g.address)!;
    const expected = entries.reduce((s, e) => s + e.delta, 0n);
    const topup = topupTotals.get(g.address) ?? 0n;
    // Actual delta is end-start; but start includes topup from a.
    // Normalize: observed round deltas = (end - start).
    const actual = endBals.get(g.address)! - startBals.get(g.address)!;
    const match = actual === expected;

    console.log("");
    console.log(
      `  ${c.bold(g.label.toUpperCase().padEnd(2))} ${g.address}   start ${fmtUsdc(startBals.get(g.address)!).padStart(10)}  →  end ${fmtUsdc(endBals.get(g.address)!).padStart(10)}  (Δ ${fmtUsdc(actual).padStart(10)})${topup > 0n ? `  [topup +${fmtUsdc(topup)}]` : ""}`,
    );
    for (const e of entries) {
      console.log(
        `     P${e.round} ${e.role.padEnd(14)} ${fmtUsdc(e.delta).padStart(10)}   ${c.dim(e.explanation)}`,
      );
    }
    console.log(
      `     ${c.bold("sum".padEnd(14))} ${fmtUsdc(expected).padStart(10)}   ${match ? c.green("✓ matches observed") : c.red("✗ DRIFT")}`,
    );
    if (!match) {
      invariantsFailed = true;
      fail(`  ${g.label} expected ${fmtUsdc(expected)}, observed ${fmtUsdc(actual)} (diff ${fmtUsdc(actual - expected)})`);
    }
    allAgentsExpectedSum += expected;
    allAgentsActualSum += actual;
  }

  // Fee wallet
  const feeEntries = ledger.get(feeWallet.address)!;
  const feeExpected = feeEntries.reduce((s, e) => s + e.delta, 0n);
  const feeActual = endBals.get(feeWallet.address)! - startBals.get(feeWallet.address)!;
  const feeMatch = feeExpected === feeActual;
  console.log("");
  console.log(
    `  ${c.bold("FEE_WALLET")} ${feeWallet.address}   start ${fmtUsdc(startBals.get(feeWallet.address)!).padStart(10)}  →  end ${fmtUsdc(endBals.get(feeWallet.address)!).padStart(10)}  (Δ ${fmtUsdc(feeActual).padStart(10)})`,
  );
  for (const e of feeEntries) {
    console.log(
      `     P${e.round} ${e.role.padEnd(14)} ${fmtUsdc(e.delta).padStart(10)}   ${c.dim(e.explanation)}`,
    );
  }
  console.log(
    `     ${c.bold("sum".padEnd(14))} ${fmtUsdc(feeExpected).padStart(10)}   ${feeMatch ? c.green("✓ matches observed") : c.red("✗ DRIFT")}`,
  );
  if (!feeMatch) invariantsFailed = true;
  allAgentsExpectedSum += feeExpected;
  allAgentsActualSum += feeActual;

  // ── Chain-total conservation ────────────────────────────────────
  console.log("");
  console.log(c.bold("━━━━━━━━━━━━━━━━━━━━━━━━━━ Conservation check ━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  const totalStart =
    Array.from(startBals.values()).reduce((s, b) => s + b, 0n) + startRouter;
  const totalEnd = Array.from(endBals.values()).reduce((s, b) => s + b, 0n) + endRouter;
  console.log(`  total USDC (tracked wallets + Router):`);
  console.log(`    start: ${fmtUsdc(totalStart).padStart(12)}`);
  console.log(`    end:   ${fmtUsdc(totalEnd).padStart(12)}`);
  console.log(`    diff:  ${fmtUsdc(totalEnd - totalStart).padStart(12)}`);
  if (totalStart !== totalEnd) {
    fail("CHAIN TOTAL DRIFTED — a non-tracked wallet received or lost USDC");
    invariantsFailed = true;
  } else {
    ok("chain total conserved across 3 rounds");
  }

  // Router should be empty (every claim drained the pool/bonds).
  if (endRouter !== startRouter) {
    fail(`Router balance drifted: ${fmtUsdc(startRouter)} → ${fmtUsdc(endRouter)} — unclaimed bond or pool leftover`);
    invariantsFailed = true;
  } else {
    ok("Router USDC balance unchanged — no trapped funds");
  }

  // Sum of expected per-wallet deltas should be zero (closed system).
  console.log(`  sum of per-wallet expected deltas: ${fmtUsdc(allAgentsExpectedSum)}`);
  console.log(`  sum of per-wallet actual deltas:   ${fmtUsdc(allAgentsActualSum)}`);

  console.log("");
  if (invariantsFailed) {
    console.log(c.red(c.bold("  ✗ INVARIANTS FAILED — see drifts above")));
    process.exit(1);
  }
  console.log(c.green(c.bold("  ✓ ALL INVARIANTS HOLD — 3 rotating-roles rounds closed cleanly")));
  console.log(c.dim(`  problems: ${results.map((r) => r.problemId).join(", ")}`));
}

main().catch((err) => {
  console.error(`\n${"\x1b[31m"}[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  process.exit(1);
});
