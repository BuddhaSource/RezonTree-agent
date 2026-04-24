#!/usr/bin/env tsx
// broadcast-multi-party.ts — Router v2.3 slash path demo.
//
// 2 solvers + 2 voters round. The winning solver and the correctly-
// aligned voter reclaim their bonds; the loser solver's commit bond
// and the wrong voter's vote bond are slashed at publishSettlement
// and added to the pool. The Merkle tree splits that expanded pool
// between the winner (90%) and fee_wallet (10%).
//
// Wallet roles (BIP-44 m/44'/60'/0'/0/N):
//   w0 (N=0) — funder + oracle + admin
//   w1 (N=1) — winning solver (claims pool + commit bond)
//   w2 (N=2) — losing solver  (commit bond SLASHED)
//   fee (N=3) — platform fee wallet (claims fee leaf)
//   w3 (N=4) — correct voter  (claims vote bond)
//   w4 (N=5) — wrong voter    (vote bond SLASHED)
//
// Slashed bonds expand the pool at settlement; the Merkle tree
// splits the expanded pool. Expected cumulative deltas, with pool0
// = fundAmount + feeAmounts (0 here), and feeBps = 1000:
//
//   w0:  -fundAmount
//   w1:  +((pool0 + w2.bond + w4.bond) × (1 - feeBps/10000)) ×
//        (no net bond change — posted + refunded)
//   w2:  -(commit bond slashed)
//   w3:   0 (bond refunded)
//   w4:  -(vote bond slashed)
//   fee: +(expanded pool) × feeBps/10000
//
// Conservation: every penny stays on-chain. Sum of deltas = 0.

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
import {
  type BalanceSnapshot,
  fmtUsdc,
  printSnapshot,
  snapshot as takeBalanceSnapshot,
} from "../src/accounting/balances.js";

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
};
const log = (s: string, d?: string) =>
  console.log(`${c.cyan(`[${s}]`)}${d ? ` ${d}` : ""}`);
const ok = (d: string) => console.log(`  ${c.green("✓")} ${d}`);
const info = (d: string) => console.log(`  ${c.dim(d)}`);
const warn = (d: string) => console.log(`  ${c.yellow("!")} ${d}`);
const fail = (d: string) => console.log(`  ${c.red("✗")} ${d}`);

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

interface Authed {
  wallet: AgentWallet;
  token: string;
  address: Address;
}

async function login(wallet: AgentWallet): Promise<Authed> {
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
  return { wallet, token: r.access_token, address: r.address };
}

// ensureFunded tops up `to` from `from` when its USDC balance is below
// `minWei`. Keeps the demo self-sufficient even on a fresh mnemonic:
// w0 seeds w3/w4 with enough USDC to post their vote bonds.
async function ensureFunded(
  from: ReturnType<typeof makeAgentWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  to: Address,
  minWei: bigint,
  topupWei: bigint,
): Promise<void> {
  const erc20 = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ]);
  const bal = (await publicClient.readContract({
    address: USDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [to],
  })) as bigint;
  if (bal >= minWei) {
    info(`${to} has ${fmtUsdc(bal)} ≥ ${fmtUsdc(minWei)}; no topup`);
    return;
  }
  warn(`${to} has ${fmtUsdc(bal)} < ${fmtUsdc(minWei)}; topping up ${fmtUsdc(topupWei)}`);
  const tx = await from.writeContract({
    address: USDC,
    abi: erc20,
    functionName: "transfer",
    args: [to, topupWei],
    account: from.account!,
    chain: from.chain,
  });
  await awaitReceipt(publicClient, tx);
  ok(`topup tx ${tx}`);
}

async function commitOne(params: {
  problem: { id: string; success_criteria: { id: string }[] };
  solver: Authed;
  walletClient: ReturnType<typeof makeAgentWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  body: string;
}): Promise<{ solutionId: string; commitIntentHash: Hex; commitBond: bigint }> {
  const { problem, solver, walletClient, publicClient, body } = params;
  const commitPre = await call<CommitPreflight>(
    "GET",
    `/v1/problems/${problem.id}/commit/preflight?submitter=${solver.address}`,
  );
  const contentHash = computeContentHash(body);
  const commitTd = buildCommitIntentTypedData({
    preflight: commitPre,
    submitter: solver.address,
    contentHash,
  });
  const commitSig = (await privateKeyToAccount(solver.wallet.privateKey).signTypedData(commitTd)) as Hex;
  const commitResp = await call<{ intent_hash: string }>(
    "POST",
    `/v1/problems/${problem.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: commitTd, signature: commitSig }),
    solver.token,
  );
  const solutionResp = await call<{ id: string }>(
    "POST",
    `/v1/problems/${problem.id}/solutions`,
    {
      intent_hash: commitResp.intent_hash,
      summary: body,
      reasoning_tree: [
        { because: "Slash-path demo.", therefore: "Only one of these can win." },
      ],
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
  const commitBond = BigInt(commitTd.message.bondAmount);
  const commitFee = BigInt(commitTd.message.feeAmount);
  const commitPermit = await signUSDCPermit(walletClient, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: commitFee + commitBond,
    deadline: commitTd.message.expiresAt,
  });
  const tx = await broadcastCommit(walletClient, {
    routerAddress: ROUTER!,
    intent: commitTd.message,
    intentSig: commitSig,
    permit: commitPermit,
  });
  info(`commit tx ${tx}`);
  await awaitReceipt(publicClient, tx);
  return {
    solutionId: solutionResp.id,
    commitIntentHash: commitResp.intent_hash as Hex,
    commitBond,
  };
}

async function voteOne(params: {
  problem: { id: string };
  voter: Authed;
  walletClient: ReturnType<typeof makeAgentWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  allocations: Allocation[];
}): Promise<{ voteIntentHash: Hex; voteBond: bigint }> {
  const { problem, voter, walletClient, publicClient, allocations } = params;
  const votePre = await call<VotePreflight>(
    "GET",
    `/v1/problems/${problem.id}/vote/preflight?voter=${voter.address}`,
  );
  const allocationsHash = computeAllocationsHash(allocations);
  const voteTd = buildVoteIntentTypedData({
    preflight: votePre,
    voter: voter.address,
    allocationsHash,
  });
  const voteSig = (await privateKeyToAccount(voter.wallet.privateKey).signTypedData(voteTd)) as Hex;
  const voteResp = await call<{ intent_hash: string }>(
    "POST",
    `/v1/problems/${problem.id}/vote-intent`,
    buildSubmitVoteIntentRequestBody({
      typedData: voteTd,
      allocations,
      signature: voteSig,
    }),
    voter.token,
  );
  const voteFee = BigInt(voteTd.message.feeAmount);
  const voteBond = BigInt(voteTd.message.bondAmount);
  const votePermit = await signUSDCPermit(walletClient, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: voteFee + voteBond,
    deadline: voteTd.message.expiresAt,
  });
  const tx = await broadcastVote(walletClient, {
    routerAddress: ROUTER!,
    intent: voteTd.message,
    intentSig: voteSig,
    permit: votePermit,
  });
  info(`vote tx ${tx}`);
  await awaitReceipt(publicClient, tx);
  return {
    voteIntentHash: voteResp.intent_hash as Hex,
    voteBond,
  };
}

async function main() {
  log("broadcast-multi-party", c.bold(`backend ${BACKEND} | router ${ROUTER}`));

  const w0 = deriveAgentWallet(MNEMONIC!, 0, CHAIN_ID);
  const w1 = deriveAgentWallet(MNEMONIC!, 1, CHAIN_ID);
  const w2 = deriveAgentWallet(MNEMONIC!, 2, CHAIN_ID);
  const feeWallet = deriveAgentWallet(MNEMONIC!, 3, CHAIN_ID);
  const w3 = deriveAgentWallet(MNEMONIC!, 4, CHAIN_ID);
  const w4 = deriveAgentWallet(MNEMONIC!, 5, CHAIN_ID);
  ok(`w0 funder/oracle  ${w0.address}`);
  ok(`w1 winning solver ${w1.address}`);
  ok(`w2 losing solver  ${w2.address}`);
  ok(`fee_wallet        ${feeWallet.address}`);
  ok(`w3 correct voter  ${w3.address}`);
  ok(`w4 wrong voter    ${w4.address}`);

  log("login");
  const [a0, a1, a2, a3, a4] = await Promise.all([
    login(w0),
    login(w1),
    login(w2),
    login(w3),
    login(w4),
  ]);
  ok("JWTs acquired");

  log("create problem");
  const problem = await call<{
    id: string;
    success_criteria: { id: string }[];
  }>(
    "POST",
    "/v1/problems",
    {
      title: `Multi-party slash demo ${Date.now()}`,
      description: "2 solvers, 2 voters; slash path exercised.",
      success_criteria: [
        { name: "primary", type: "boolean", target: "true", weight: 100 },
      ],
      initial_bounty: "0",
    },
    a0.token,
  );
  ok(`problem ${problem.id}`);

  const walletClient0 = makeAgentWalletClient({ privateKey: w0.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const walletClient1 = makeAgentWalletClient({ privateKey: w1.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const walletClient2 = makeAgentWalletClient({ privateKey: w2.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const walletClient3 = makeAgentWalletClient({ privateKey: w3.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const walletClient4 = makeAgentWalletClient({ privateKey: w4.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const walletClientFee = makeAgentWalletClient({ privateKey: feeWallet.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const publicClient = createPublicClient({ transport: http(RPC) });

  // Top up w3 + w4 from w0 if they lack bond USDC. Keeps the demo
  // reproducible on a fresh HD wallet set; no-op after the first run.
  log("ensure voters funded");
  await ensureFunded(walletClient0, publicClient, w3.address, 1_200_000n, 1_500_000n);
  await ensureFunded(walletClient0, publicClient, w4.address, 1_200_000n, 1_500_000n);

  const knownQids: Hex[] = [];
  const knownSolutionHashes: Hex[] = [];
  const knownVoteHashes: Hex[] = [];

  async function snap(): Promise<BalanceSnapshot> {
    return takeBalanceSnapshot({
      publicClient,
      usdc: USDC,
      router: ROUTER!,
      wallets: [
        { name: "w0 funder/oracle", address: a0.address },
        { name: "w1 winning solver", address: a1.address },
        { name: "w2 losing solver ", address: a2.address },
        { name: "fee_wallet       ", address: feeWallet.address },
        { name: "w3 correct voter ", address: a3.address },
        { name: "w4 wrong voter   ", address: a4.address },
      ],
      qids: knownQids,
      solutionIntentHashes: knownSolutionHashes,
      voteIntentHashes: knownVoteHashes,
    });
  }

  const snap0 = await snap();
  printSnapshot(snap0, "Initial balance sheet");
  const initialChainTotal = snap0.totalUsdc;

  // ── STEP 1 — FUND (w0) ───────────────────────────────────────────
  log("1/9 fund", "w0 → Router.fund()");
  const fundPre = await call<FundPreflight>(
    "GET",
    `/v1/problems/${problem.id}/fund/preflight?funder=${a0.address}`,
  );
  const fundAmount = parseAmountToWei("1", fundPre.token.decimals);
  const fundTd = buildFundIntentTypedData({
    preflight: fundPre,
    funder: a0.address,
    amountWei: fundAmount,
  });
  const fundSig = (await privateKeyToAccount(w0.privateKey).signTypedData(fundTd)) as Hex;
  await call(
    "POST",
    `/v1/problems/${problem.id}/fund`,
    buildFundRequestBody({ typedData: fundTd, signature: fundSig }),
    a0.token,
  );
  const qid = fundTd.message.questionId;
  knownQids.push(qid);
  const fundPermit = await signUSDCPermit(walletClient0, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: fundAmount,
    deadline: fundTd.message.expiresAt,
  });
  const fundTx = await broadcastFund(walletClient0, {
    routerAddress: ROUTER!,
    intent: fundTd.message,
    intentSig: fundSig,
    permit: fundPermit,
  });
  info(`fund tx ${fundTx}`);
  await awaitReceipt(publicClient, fundTx);
  ok(`pool seeded with ${fmtUsdc(fundAmount)}`);

  // ── STEP 2 — COMMIT w1 (winning solver) ─────────────────────────
  log("2/9 commit", "w1 → Router.commitSolution() (winner)");
  const winnerCommit = await commitOne({
    problem,
    solver: a1,
    walletClient: walletClient1,
    publicClient,
    body: "Truth survives scrutiny. Solution A — the winner.",
  });
  knownSolutionHashes.push(winnerCommit.commitIntentHash);
  ok(`winner solution ${winnerCommit.solutionId}`);

  // ── STEP 3 — COMMIT w2 (losing solver — bond will be SLASHED) ───
  log("3/9 commit", "w2 → Router.commitSolution() (loser — will be slashed)");
  const loserCommit = await commitOne({
    problem,
    solver: a2,
    walletClient: walletClient2,
    publicClient,
    body: "Falsehood disguised as rigor. Solution B — the loser.",
  });
  knownSolutionHashes.push(loserCommit.commitIntentHash);
  ok(`loser solution ${loserCommit.solutionId}`);

  // ── STEP 4 — VOTE w3 (correct — votes for winner) ───────────────
  log("4/9 vote", "w3 → Router.castVote() (correct — for winner)");
  const correctVote = await voteOne({
    problem,
    voter: a3,
    walletClient: walletClient3,
    publicClient,
    allocations: [{ solution_id: winnerCommit.solutionId, points: 100 }],
  });
  knownVoteHashes.push(correctVote.voteIntentHash);
  ok(`correct vote ${correctVote.voteIntentHash.slice(0, 10)}…`);

  // ── STEP 5 — VOTE w4 (wrong — bond will be SLASHED) ─────────────
  log("5/9 vote", "w4 → Router.castVote() (wrong — will be slashed)");
  const wrongVote = await voteOne({
    problem,
    voter: a4,
    walletClient: walletClient4,
    publicClient,
    allocations: [{ solution_id: loserCommit.solutionId, points: 100 }],
  });
  knownVoteHashes.push(wrongVote.voteIntentHash);
  ok(`wrong vote ${wrongVote.voteIntentHash.slice(0, 10)}…`);

  // ── STEP 6 — SETTLE with slash ──────────────────────────────────
  log("6/9 settle", "w0 (oracle) → publishSettlement() with slash lists");
  // Read pool *before* slash — the Router adds slashed bonds to the
  // pool atomically inside publishSettlement. The oracle must build
  // the Merkle tree against the expected post-slash pool.
  const qStateBefore = (await publicClient.readContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "questions",
    args: [qid],
  })) as [number, Address, number, bigint, bigint];
  const poolBefore = qStateBefore[3];
  const expandedPool = poolBefore + loserCommit.commitBond + wrongVote.voteBond;
  const feeAmount = (expandedPool * PLATFORM_FEE_BPS) / 10000n;
  const winnerAmount = expandedPool - feeAmount;
  info(
    `pool pre-slash ${fmtUsdc(poolBefore)}; slashed bonds +${fmtUsdc(loserCommit.commitBond)} (commit) +${fmtUsdc(wrongVote.voteBond)} (vote); expanded ${fmtUsdc(expandedPool)}`,
  );
  info(
    `fee ${PLATFORM_FEE_BPS}bp = ${fmtUsdc(feeAmount)}; winner = ${fmtUsdc(winnerAmount)}`,
  );

  const leaves: MerkleLeaf[] = [
    { questionId: qid, recipient: a1.address, amount: winnerAmount },
    { questionId: qid, recipient: feeWallet.address, amount: feeAmount },
  ];
  const leafHashes = leaves.map(hashLeaf);
  const root = merkleRoot(leaves);
  const winnerProof = merkleProof(leafHashes, 0);
  const feeProof = merkleProof(leafHashes, 1);

  const slashedCommitHashes: Hex[] = [loserCommit.commitIntentHash];
  const slashedVoteHashes: Hex[] = [wrongVote.voteIntentHash];
  const settleTd = buildSettlementIntentTypedData({
    routerAddress: ROUTER!,
    chainId: CHAIN_ID,
    questionId: qid,
    merkleRoot: root,
    slashedCommitHashes,
    slashedVoteHashes,
    expiresAtSeconds: Math.floor(Date.now() / 1000) + DEFAULT_SETTLEMENT_TTL_SECONDS,
  });
  const oracleSig = (await privateKeyToAccount(w0.privateKey).signTypedData(settleTd)) as Hex;
  const settleTx = await broadcastPublishSettlement(walletClient0, {
    routerAddress: ROUTER!,
    questionId: qid,
    merkleRoot: root,
    expiresAt: settleTd.message.expiresAt,
    slashedCommitHashes,
    slashedVoteHashes,
    oracleSig,
  });
  info(`settle tx ${settleTx}`);
  await awaitReceipt(publicClient, settleTx);
  ok(`settled — ${slashedCommitHashes.length} commit bond(s) + ${slashedVoteHashes.length} vote bond(s) slashed`);
  // Read-your-writes lag on public Base Sepolia RPC.
  await new Promise((r) => setTimeout(r, 4000));

  // ── STEP 7 — CLAIM WINNER + FEE ─────────────────────────────────
  log("7/9 claim winner+fee", "w1 then fee_wallet → Router.claim()");
  const claimWinnerTx = await broadcastClaim(walletClient1, {
    routerAddress: ROUTER!,
    questionId: qid,
    amount: winnerAmount,
    proof: winnerProof,
  });
  await awaitReceipt(publicClient, claimWinnerTx);
  ok(`winner claim tx ${claimWinnerTx}`);
  const claimFeeTx = await broadcastClaim(walletClientFee, {
    routerAddress: ROUTER!,
    questionId: qid,
    amount: feeAmount,
    proof: feeProof,
  });
  await awaitReceipt(publicClient, claimFeeTx);
  ok(`fee claim tx ${claimFeeTx}`);

  // ── STEP 8 — BOND REFUNDS (winner + correct voter) ──────────────
  log("8/9 bond refunds", "winner + correct voter reclaim bonds");
  const w1BondTx = await walletClient1.writeContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "claimSolutionBond",
    args: [qid, winnerCommit.commitIntentHash],
    account: walletClient1.account!,
    chain: walletClient1.chain,
  });
  await awaitReceipt(publicClient, w1BondTx);
  ok(`w1 commit bond refund tx ${w1BondTx}`);
  const w3BondTx = await walletClient3.writeContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "claimVoteBond",
    args: [qid, correctVote.voteIntentHash],
    account: walletClient3.account!,
    chain: walletClient3.chain,
  });
  await awaitReceipt(publicClient, w3BondTx);
  ok(`w3 vote bond refund tx ${w3BondTx}`);

  // ── STEP 9 — ASSERT SLASHED BONDS REVERT ────────────────────────
  log("9/9 assert slashes", "w2 + w4 claimBond must revert (RouterBondAlreadyClaimed)");

  async function expectRevert(
    what: string,
    fn: () => Promise<Hex>,
  ): Promise<void> {
    try {
      const tx = await fn();
      await awaitReceipt(publicClient, tx);
      throw new Error(`${what} succeeded; expected revert`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("RouterBondAlreadyClaimed") ||
        msg.includes("reverted") ||
        msg.includes("execution reverted")
      ) {
        ok(`${what}: reverted as expected`);
        return;
      }
      throw err;
    }
  }

  await expectRevert("w2 claimSolutionBond", async () =>
    walletClient2.writeContract({
      address: ROUTER!,
      abi: ROUTER_V2_ABI,
      functionName: "claimSolutionBond",
      args: [qid, loserCommit.commitIntentHash],
      account: walletClient2.account!,
      chain: walletClient2.chain,
    }),
  );
  await expectRevert("w4 claimVoteBond", async () =>
    walletClient4.writeContract({
      address: ROUTER!,
      abi: ROUTER_V2_ABI,
      functionName: "claimVoteBond",
      args: [qid, wrongVote.voteIntentHash],
      account: walletClient4.account!,
      chain: walletClient4.chain,
    }),
  );

  // ── FINAL AUDIT ──────────────────────────────────────────────────
  const snapN = await snap();
  printSnapshot(snapN, "Final balance sheet");

  const finalChainTotal = snapN.totalUsdc;
  if (finalChainTotal !== initialChainTotal) {
    fail(
      `CHAIN TOTAL DRIFTED: before ${fmtUsdc(initialChainTotal)}, after ${fmtUsdc(finalChainTotal)} (diff ${fmtUsdc(finalChainTotal - initialChainTotal)})`,
    );
    process.exit(1);
  }

  const findDelta = (addr: Address): bigint =>
    (snapN.wallets.find((w) => w.address === addr)?.usdc ?? 0n) -
    (snap0.wallets.find((w) => w.address === addr)?.usdc ?? 0n);
  const w0Delta = findDelta(a0.address);
  const w1Delta = findDelta(a1.address);
  const w2Delta = findDelta(a2.address);
  const feeDelta = findDelta(feeWallet.address);
  const w3Delta = findDelta(a3.address);
  const w4Delta = findDelta(a4.address);

  // ensureFunded may have shifted USDC from w0 to w3/w4 before the
  // round (0 or 1.5 USDC each, depending on their starting balance).
  // w0/w3/w4 cumulative deltas include that topup; the strict asserts
  // below use invariants that don't depend on it.

  console.log("");
  console.log(c.bold("── Round cumulative delta (post-topup baseline) ──"));
  console.log(`  w0 funder/oracle:  ${fmtUsdc(w0Delta).padStart(14)}   (expected: -${fmtUsdc(fundAmount).replace(/^-/, "")} minus any w3/w4 topup)`);
  console.log(`  w1 winning solver: ${fmtUsdc(w1Delta).padStart(14)}   (expected: +${fmtUsdc(winnerAmount).replace(/^-/, "")} pool + bond refund net 0)`);
  console.log(`  w2 losing solver:  ${fmtUsdc(w2Delta).padStart(14)}   (expected: -${fmtUsdc(loserCommit.commitBond).replace(/^-/, "")} commit bond SLASHED)`);
  console.log(`  w3 correct voter:  ${fmtUsdc(w3Delta).padStart(14)}   (expected:  0 ± topup; vote bond refunded)`);
  console.log(`  w4 wrong voter:    ${fmtUsdc(w4Delta).padStart(14)}   (expected: -${fmtUsdc(wrongVote.voteBond).replace(/^-/, "")} ± topup; vote bond SLASHED)`);
  console.log(`  fee_wallet:        ${fmtUsdc(feeDelta).padStart(14)}   (expected: +${fmtUsdc(feeAmount).replace(/^-/, "")} platform ${PLATFORM_FEE_BPS}bp of expanded pool)`);
  console.log(`  chain total conserved: ${c.green("✓")}`);

  // Strict invariants that don't depend on the topup baseline:
  //  - chain total unchanged (already checked)
  //  - fee_wallet gained exactly feeAmount
  //  - w1 gained exactly winnerAmount (posted bond + refunded = 0 net for bond)
  //  - w2 lost exactly commitBond (slashed + no refund)
  if (feeDelta !== feeAmount) {
    fail(`fee_wallet delta ${fmtUsdc(feeDelta)} ≠ expected ${fmtUsdc(feeAmount)}`);
    process.exit(1);
  }
  if (w1Delta !== winnerAmount) {
    fail(`w1 delta ${fmtUsdc(w1Delta)} ≠ expected winner ${fmtUsdc(winnerAmount)}`);
    process.exit(1);
  }
  if (w2Delta !== -loserCommit.commitBond) {
    fail(`w2 delta ${fmtUsdc(w2Delta)} ≠ expected -${fmtUsdc(loserCommit.commitBond)}`);
    process.exit(1);
  }

  console.log("");
  console.log(c.green(c.bold("  Multi-party slash demo: audit PASS.")));
  console.log(c.dim(`  Problem: ${problem.id} (qid ${qid.slice(0, 18)}…)`));
  console.log(c.dim(`  Slashed: 1 commit bond (${fmtUsdc(loserCommit.commitBond)}) + 1 vote bond (${fmtUsdc(wrongVote.voteBond)})`));
}

main().catch((err) => {
  console.error(`\n${"\x1b[31m"}[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  process.exit(1);
});
