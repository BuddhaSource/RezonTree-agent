#!/usr/bin/env tsx
// broadcast-full.ts — full Model C closure across Fund + Commit +
// Vote + Settle + Claim + Bond recovery, with per-step accounting
// verification.
//
// Wallet roles (BIP-44 m/44'/60'/0'/0/N):
//   w0 (N=0) — questioner + funder + oracle + admin
//   w1 (N=1) — solver (commits, claims pool, claims commit bond)
//   w2 (N=2) — voter (claims vote bond)
//   fee   (N=3) — platform fee wallet (not yet populated by Router)
//
// Steady-state economics per round (after bond recovery), with
// platform fee of PLATFORM_FEE_BPS basis points:
//   w0:         -fundAmount            (full bounty)
//   w1:         +fundAmount × (1 - feeBps/10000)  (pool share)
//   w2:          0                     (bond refunded)
//   fee_wallet: +fundAmount × (feeBps/10000)      (platform cut)
//   Router:      0                     (fund flows through; bonds in+out)
//   Chain total: unchanged             (USDC never leaves the system)
//
// Each step is audited: snapshot → broadcast → snapshot → verify
// the delta matches an explicit ExpectedDelta. Any mismatch aborts
// the script with the specific line that drifted.

import { execSync } from "node:child_process";
import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
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
  type ExpectedDelta,
  fmtUsdc,
  printDelta,
  printSnapshot,
  snapshot as takeBalanceSnapshot,
  verifyDelta,
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

// Platform fee rate in basis points (10000 = 100%). 1000 = 10%.
// Applied to the pool at settlement time: the Merkle tree carries
// one leaf for the winning solver (pool × (10000 - FEE_BPS) / 10000)
// and one leaf for the fee_wallet (pool × FEE_BPS / 10000). Winner
// + fee_wallet sum to the pool exactly — no residual.
const PLATFORM_FEE_BPS = BigInt(
  process.env.RT_PLATFORM_FEE_BPS ?? "1000",
);

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

async function pollDB(query: string, expect: string, label: string, limitSec = 30): Promise<void> {
  for (let i = 0; i < Math.floor(limitSec / 2); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const out = execSync(
      `docker exec rezontree-postgres-1 psql -U rezontree -d rezontree -Atc "${query}"`,
      { encoding: "utf-8" },
    ).trim();
    if (out === expect) {
      ok(`${label} → ${expect}`);
      return;
    }
    info(`  [${i + 1}] ${label}=${out}`);
  }
  throw new Error(`${label} did not reach ${expect} within ${limitSec}s`);
}

async function main() {
  log("broadcast-full", c.bold(`backend ${BACKEND} | router ${ROUTER}`));

  // Derive 4 wallets (3 roles + platform fee holder).
  const w0 = deriveAgentWallet(MNEMONIC!, 0, CHAIN_ID);
  const w1 = deriveAgentWallet(MNEMONIC!, 1, CHAIN_ID);
  const w2 = deriveAgentWallet(MNEMONIC!, 2, CHAIN_ID);
  const feeWallet = deriveAgentWallet(MNEMONIC!, 3, CHAIN_ID);
  ok(`w0 questioner ${w0.address}`);
  ok(`w1 solver     ${w1.address}`);
  ok(`w2 voter      ${w2.address}`);
  ok(`fee_wallet    ${feeWallet.address}`);

  // Login all three active roles.
  log("login");
  const [a0, a1, a2] = await Promise.all([login(w0), login(w1), login(w2)]);
  ok("JWTs acquired");

  // Create problem.
  log("create problem");
  const problem = await call<{
    id: string;
    success_criteria: { id: string }[];
  }>(
    "POST",
    "/v1/problems",
    {
      title: `Audited broadcast ${Date.now()}`,
      description: "Full Fund→Commit→Vote→Settle→Claim cycle with accounting.",
      success_criteria: [
        { name: "primary", type: "boolean", target: "true", weight: 100 },
      ],
      initial_bounty: "0",
    },
    a0.token,
  );
  ok(`problem ${problem.id}`);

  // RPC clients.
  const walletClient0 = makeAgentWalletClient({
    privateKey: w0.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const walletClient1 = makeAgentWalletClient({
    privateKey: w1.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const walletClient2 = makeAgentWalletClient({
    privateKey: w2.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const walletClientFee = makeAgentWalletClient({
    privateKey: feeWallet.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const publicClient = createPublicClient({
    transport: http(RPC),
  });

  // Track known on-chain entities for balance snapshots.
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
        { name: "w1 solver", address: a1.address },
        { name: "w2 voter", address: a2.address },
        { name: "fee_wallet", address: feeWallet.address },
      ],
      qids: knownQids,
      solutionIntentHashes: knownSolutionHashes,
      voteIntentHashes: knownVoteHashes,
    });
  }

  async function auditStep(
    label: string,
    before: BalanceSnapshot,
    expected: ExpectedDelta,
  ): Promise<BalanceSnapshot> {
    // Public Base Sepolia RPCs serve stale `latest` for ~2s after a
    // tx mines. awaitReceipt blocks until the tx is in a block, but
    // the RPC node may not have updated its `latest`-view state
    // readers query. Sleep before reading so balanceOf reflects
    // post-tx state.
    await new Promise((r) => setTimeout(r, 2500));
    const after = await snap();
    const result = verifyDelta(before, after, expected);
    printDelta(before, after, label);
    if (result.ok) {
      ok(`accounting ✓ ${label}`);
    } else {
      fail(`accounting MISMATCH on ${label}:`);
      for (const m of result.mismatches) console.log(`  ${c.red("✗")} ${m}`);
      throw new Error(`Accounting failure at step: ${label}`);
    }
    return after;
  }

  // ── Initial balance sheet ────────────────────────────────────────
  const snap0 = await snap();
  printSnapshot(snap0, "Initial balance sheet");
  const initialChainTotal = snap0.totalUsdc;

  // =========================================================================
  // STEP 1 — FUND (w0)
  // =========================================================================
  log("1/7 fund", "w0 → Router.fund()");
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
  const fundResp = await call<{ intent_hash: string; contribution_id: string }>(
    "POST",
    `/v1/problems/${problem.id}/fund`,
    buildFundRequestBody({ typedData: fundTd, signature: fundSig }),
    a0.token,
  );
  ok(`backend row ${fundResp.contribution_id}`);

  const qid = fundTd.message.questionId;
  knownQids.push(qid);

  const fundPermit = await signUSDCPermit(walletClient0, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: fundAmount,
    deadline: fundTd.message.expiresAt,
  });
  const before1 = await snap();
  const fundTx = await broadcastFund(walletClient0, {
    routerAddress: ROUTER!,
    intent: fundTd.message,
    intentSig: fundSig,
    permit: fundPermit,
  });
  info(`fund tx ${fundTx}`);
  await awaitReceipt(publicClient, fundTx);
  await auditStep("Fund → Router.fund()", before1, {
    action: "fund",
    byAddress: { [a0.address]: -fundAmount },
    routerTotal: fundAmount,
    qid,
    poolDelta: fundAmount,
    chainTotal: 0n,
  });
  await pollDB(
    `SELECT confirmation_status FROM contributions WHERE id = '${fundResp.contribution_id}'`,
    "confirmed",
    "fund-backend-flip",
  );

  // =========================================================================
  // STEP 2 — COMMIT (w1)
  // =========================================================================
  log("2/7 commit", "w1 → Router.commitSolution()");
  const commitPre = await call<CommitPreflight>(
    "GET",
    `/v1/problems/${problem.id}/commit/preflight?submitter=${a1.address}`,
  );
  const solutionBody = "Truth is what survives scrutiny. Audited broadcast.";
  const contentHash = computeContentHash(solutionBody);
  const commitTd = buildCommitIntentTypedData({
    preflight: commitPre,
    submitter: a1.address,
    contentHash,
  });
  const commitSig = (await privateKeyToAccount(w1.privateKey).signTypedData(commitTd)) as Hex;
  const commitResp = await call<{ intent_hash: string }>(
    "POST",
    `/v1/problems/${problem.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: commitTd, signature: commitSig }),
    a1.token,
  );
  const solutionResp = await call<{ id: string }>(
    "POST",
    `/v1/problems/${problem.id}/solutions`,
    {
      intent_hash: commitResp.intent_hash,
      summary: solutionBody,
      reasoning_tree: [
        { because: "Audit validates accounting invariants.", therefore: "Drifts are caught at source." },
      ],
      claims: [
        {
          criterion_id: problem.success_criteria[0].id,
          value: true,
          argument: "By construction.",
          falsifiable_by: "Audit failure.",
        },
      ],
    },
    a1.token,
  );
  ok(`solution ${solutionResp.id}`);

  const commitFee = BigInt(commitTd.message.feeAmount);
  const commitBond = BigInt(commitTd.message.bondAmount);
  const commitIntentHash = commitResp.intent_hash as Hex;
  knownSolutionHashes.push(commitIntentHash);

  const commitPermit = await signUSDCPermit(walletClient1, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: commitFee + commitBond,
    deadline: commitTd.message.expiresAt,
  });
  const before2 = await snap();
  const commitTx = await broadcastCommit(walletClient1, {
    routerAddress: ROUTER!,
    intent: commitTd.message,
    intentSig: commitSig,
    permit: commitPermit,
  });
  info(`commit tx ${commitTx}`);
  await awaitReceipt(publicClient, commitTx);
  await auditStep("Commit → Router.commitSolution()", before2, {
    action: "commit",
    byAddress: { [a1.address]: -(commitFee + commitBond) },
    routerTotal: commitFee + commitBond,
    qid,
    poolDelta: commitFee,
    intentHash: commitIntentHash,
    solutionBondDelta: commitBond,
    chainTotal: 0n,
  });
  await pollDB(
    `SELECT confirmation_status FROM solutions WHERE id = '${solutionResp.id}'`,
    "confirmed",
    "commit-backend-flip",
  );

  // =========================================================================
  // STEP 3 — VOTE (w2)
  // =========================================================================
  log("3/7 vote", "w2 → Router.castVote()");
  const votePre = await call<VotePreflight>(
    "GET",
    `/v1/problems/${problem.id}/vote/preflight?voter=${a2.address}`,
  );
  const allocations: Allocation[] = [
    { solution_id: solutionResp.id, points: 100 },
  ];
  const allocationsHash = computeAllocationsHash(allocations);
  const voteTd = buildVoteIntentTypedData({
    preflight: votePre,
    voter: a2.address,
    allocationsHash,
  });
  const voteSig = (await privateKeyToAccount(w2.privateKey).signTypedData(voteTd)) as Hex;
  const voteResp = await call<{ intent_hash: string }>(
    "POST",
    `/v1/problems/${problem.id}/vote-intent`,
    buildSubmitVoteIntentRequestBody({
      typedData: voteTd,
      allocations,
      signature: voteSig,
    }),
    a2.token,
  );
  ok(`vote intent ${voteResp.intent_hash.slice(0, 10)}…`);

  const voteFee = BigInt(voteTd.message.feeAmount);
  const voteBond = BigInt(voteTd.message.bondAmount);
  const voteIntentHash = voteResp.intent_hash as Hex;
  knownVoteHashes.push(voteIntentHash);

  const votePermit = await signUSDCPermit(walletClient2, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: voteFee + voteBond,
    deadline: voteTd.message.expiresAt,
  });
  const before3 = await snap();
  const voteTx = await broadcastVote(walletClient2, {
    routerAddress: ROUTER!,
    intent: voteTd.message,
    intentSig: voteSig,
    permit: votePermit,
  });
  info(`vote tx ${voteTx}`);
  await awaitReceipt(publicClient, voteTx);
  await auditStep("Vote → Router.castVote()", before3, {
    action: "vote",
    byAddress: { [a2.address]: -(voteFee + voteBond) },
    routerTotal: voteFee + voteBond,
    qid,
    poolDelta: voteFee,
    intentHash: voteIntentHash,
    voteBondDelta: voteBond,
    chainTotal: 0n,
  });
  await pollDB(
    `SELECT confirmation_status FROM votes WHERE intent_hash = decode('${voteResp.intent_hash.replace(/^0x/, "")}','hex')`,
    "confirmed",
    "vote-backend-flip",
  );

  // =========================================================================
  // STEP 4 — SETTLE (w0 as oracle) — 2-leaf tree: winner + platform fee
  // =========================================================================
  log("4/8 settle", "w0 (oracle) → Router.publishSettlement()");
  const qState = (await publicClient.readContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "questions",
    args: [qid],
  })) as [number, Address, number, bigint, bigint];
  const poolAmount = qState[3];
  const feeAmount = (poolAmount * PLATFORM_FEE_BPS) / 10000n;
  const winnerAmount = poolAmount - feeAmount;
  info(
    `pool = ${fmtUsdc(poolAmount)}; fee ${PLATFORM_FEE_BPS}bp = ${fmtUsdc(feeAmount)}; winner = ${fmtUsdc(winnerAmount)}`,
  );
  if (poolAmount === 0n) throw new Error("pool 0, cannot settle");

  // Leaves MUST be in a fixed order — the proof depends on index.
  // [0] winner, [1] platform fee.
  const leaves: MerkleLeaf[] = [
    { questionId: qid, recipient: a1.address, amount: winnerAmount },
    { questionId: qid, recipient: feeWallet.address, amount: feeAmount },
  ];
  const leafHashes = leaves.map(hashLeaf);
  const root = merkleRoot(leaves);
  const winnerProof = merkleProof(leafHashes, 0);
  const feeProof = merkleProof(leafHashes, 1);

  // One solver, one voter, both winners → no slashing in this demo.
  // The signed envelope still includes the empty slash lists so the
  // oracle sig covers them (prevents mix-and-match attacks).
  const slashedCommitHashes: Hex[] = [];
  const slashedVoteHashes: Hex[] = [];
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

  const before4 = await snap();
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
  await auditStep("Settle → Router.publishSettlement()", before4, {
    action: "settle",
    byAddress: {},
    routerTotal: 0n,
    chainTotal: 0n, // no USDC movement on settle
  });

  // 4s delay — public Base Sepolia RPC lag for read-your-writes.
  await new Promise((r) => setTimeout(r, 4000));

  // =========================================================================
  // STEP 5 — CLAIM WINNER (w1)
  // =========================================================================
  log("5/8 claim winner", "w1 → Router.claim(winnerAmount)");
  const before5 = await snap();
  const claimTx = await broadcastClaim(walletClient1, {
    routerAddress: ROUTER!,
    questionId: qid,
    amount: winnerAmount,
    proof: winnerProof,
  });
  info(`claim tx ${claimTx}`);
  await awaitReceipt(publicClient, claimTx);
  await auditStep("Claim winner → Router.claim()", before5, {
    action: "claim",
    byAddress: { [a1.address]: winnerAmount },
    routerTotal: -winnerAmount,
    qid,
    poolDelta: -winnerAmount,
    chainTotal: 0n,
  });

  // =========================================================================
  // STEP 6 — CLAIM PLATFORM FEE (fee_wallet)
  // =========================================================================
  log("6/8 claim fee", "fee_wallet → Router.claim(feeAmount)");
  const before5b = await snap();
  const feeClaimTx = await broadcastClaim(walletClientFee, {
    routerAddress: ROUTER!,
    questionId: qid,
    amount: feeAmount,
    proof: feeProof,
  });
  info(`fee claim tx ${feeClaimTx}`);
  await awaitReceipt(publicClient, feeClaimTx);
  await auditStep("Claim fee → Router.claim() by fee_wallet", before5b, {
    action: "claim",
    byAddress: { [feeWallet.address]: feeAmount },
    routerTotal: -feeAmount,
    qid,
    poolDelta: -feeAmount,
    chainTotal: 0n,
  });

  // =========================================================================
  // STEP 7 — CLAIM SOLUTION BOND (w1)
  // =========================================================================
  log("7/8 claim commit bond", "w1 → Router.claimSolutionBond()");
  const before6 = await snap();
  const claimSolBondTx = await walletClient1.writeContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "claimSolutionBond",
    args: [qid, commitIntentHash],
    account: walletClient1.account!,
    chain: walletClient1.chain,
  });
  info(`claimSolutionBond tx ${claimSolBondTx}`);
  await awaitReceipt(publicClient, claimSolBondTx);
  await auditStep("Claim commit bond → Router.claimSolutionBond()", before6, {
    action: "claim_solution_bond",
    byAddress: { [a1.address]: commitBond },
    routerTotal: -commitBond,
    intentHash: commitIntentHash,
    solutionBondDelta: -commitBond,
    chainTotal: 0n,
  });

  // =========================================================================
  // STEP 8 — CLAIM VOTE BOND (w2)
  // =========================================================================
  log("8/8 claim vote bond", "w2 → Router.claimVoteBond()");
  const before7 = await snap();
  const claimVoteBondTx = await walletClient2.writeContract({
    address: ROUTER!,
    abi: ROUTER_V2_ABI,
    functionName: "claimVoteBond",
    args: [qid, voteIntentHash],
    account: walletClient2.account!,
    chain: walletClient2.chain,
  });
  info(`claimVoteBond tx ${claimVoteBondTx}`);
  await awaitReceipt(publicClient, claimVoteBondTx);
  await auditStep("Claim vote bond → Router.claimVoteBond()", before7, {
    action: "claim_vote_bond",
    byAddress: { [a2.address]: voteBond },
    routerTotal: -voteBond,
    intentHash: voteIntentHash,
    voteBondDelta: -voteBond,
    chainTotal: 0n,
  });

  // ── Final balance sheet + cumulative check ───────────────────────
  const snapN = await snap();
  printSnapshot(snapN, "Final balance sheet");

  const finalChainTotal = snapN.totalUsdc;
  if (finalChainTotal !== initialChainTotal) {
    fail(
      `CHAIN TOTAL DRIFTED: before ${fmtUsdc(initialChainTotal)}, after ${fmtUsdc(finalChainTotal)} (diff ${fmtUsdc(finalChainTotal - initialChainTotal)})`,
    );
    process.exit(1);
  }

  // Cumulative per-wallet deltas (expected for one zero-sum round
  // with PLATFORM_FEE_BPS fee routed to fee_wallet).
  const findDelta = (addr: Address): bigint =>
    (snapN.wallets.find((w) => w.address === addr)?.usdc ?? 0n) -
    (snap0.wallets.find((w) => w.address === addr)?.usdc ?? 0n);
  const w0Delta = findDelta(a0.address);
  const w1Delta = findDelta(a1.address);
  const w2Delta = findDelta(a2.address);
  const feeDelta = findDelta(feeWallet.address);

  console.log("");
  console.log(c.bold("── Round cumulative Δ ──"));
  console.log(`  w0 funder:   ${fmtUsdc(w0Delta).padStart(14)}   (expected: -${fmtUsdc(fundAmount).replace(/^-/, "")} — full bounty paid)`);
  console.log(`  w1 solver:   ${fmtUsdc(w1Delta).padStart(14)}   (expected: +${fmtUsdc(winnerAmount).replace(/^-/, "")} — pool × ${10000n - PLATFORM_FEE_BPS}/10000; bond refunded)`);
  console.log(`  w2 voter:    ${fmtUsdc(w2Delta).padStart(14)}   (expected:  0 — bond refunded)`);
  console.log(`  fee_wallet:  ${fmtUsdc(feeDelta).padStart(14)}   (expected: +${fmtUsdc(feeAmount).replace(/^-/, "")} — platform ${PLATFORM_FEE_BPS}bp cut)`);
  console.log(`  chain total conserved: ${c.green("✓")}`);

  const expectedW0 = -fundAmount;
  const expectedW1 = winnerAmount;
  const expectedW2 = 0n;
  const expectedFee = feeAmount;
  if (
    w0Delta !== expectedW0 ||
    w1Delta !== expectedW1 ||
    w2Delta !== expectedW2 ||
    feeDelta !== expectedFee
  ) {
    fail("Cumulative round deltas differ from expected split.");
    process.exit(1);
  }

  console.log("");
  console.log(c.green(c.bold("  Fund → Commit → Vote → Settle → 2-leaf Claim (winner + fee) → Bond recovery: audit PASS.")));
  console.log(c.dim(`  Problem: ${problem.id} (qid ${qid.slice(0, 18)}…)`));
}

main().catch((err) => {
  console.error(`\n${"\x1b[31m"}[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  process.exit(1);
});
