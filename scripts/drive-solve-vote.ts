#!/usr/bin/env tsx
// drive-solve-vote.ts — non-agent driver for the diagnostic.
//
// Drives one solution + one vote on a target question, using the same
// SDK functions the MCP server uses, but without the Claude agent
// surrounding it. Cheaper and more reliable than spawning a Claude
// agent for a one-shot test.
//
// Usage:
//   tsx scripts/drive-solve-vote.ts <question_id>
//
// Env (loaded from .env):
//   RT_AGENT_MNEMONIC       — BIP-39 phrase
//   RT_AGENT_BACKEND_URL    — backend (default http://localhost:8080)
//   RT_FORGE_ADDRESS        — deployed Router/Forge address
//   RT_RPC_URL              — chain RPC (default sepolia.base.org)
//   RT_AGENT_CHAIN_ID       — chain id (default 84532)
//   RT_USDC_ADDRESS         — USDC contract (default Base Sepolia USDC)
//   SOLVER_INDEX            — wallet idx for solver (default 5 = gen-solver-04)
//   VOTER_INDEX             — wallet idx for voter  (default 4 = gen-solver-03)

import "dotenv/config";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { canonicalStringify } from "../src/intents/commit-intent.js";
import {
  ensureUsdcAllowance,
  runCommitFlow,
  runVoteFlow,
} from "../src/forge/quadphase-flow.js";
import { awaitReceipt } from "../src/forge/client.js";

const API = process.env.RT_AGENT_BACKEND_URL || "http://localhost:8080";
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const RPC = process.env.RT_RPC_URL || "https://sepolia.base.org";
const CHAIN_ID = Number(process.env.RT_AGENT_CHAIN_ID || "84532");
const USDC = (process.env.RT_USDC_ADDRESS as Address) ||
  ("0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address);
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const SOLVER_IDX = Number(process.env.SOLVER_INDEX || "5");
const VOTER_IDX = Number(process.env.VOTER_INDEX || "4");

const qid = process.argv[2];
if (!qid) {
  console.error("usage: tsx drive-solve-vote.ts <question_id>");
  process.exit(2);
}
if (!FORGE || !MNEMONIC) {
  console.error("RT_FORGE_ADDRESS + RT_AGENT_MNEMONIC required");
  process.exit(2);
}

function makeClients(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const transport = http(RPC);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  return { account, publicClient, walletClient };
}

async function login(walletIdx: number): Promise<{ bearer: string; address: Address; privateKey: Hex }> {
  const domain = loadLoginDomain();
  const wallet = deriveAgentWallet(MNEMONIC, walletIdx, domain.chainId);
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain,
  });
  const res = await fetch(`${API}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { accessToken: string };
  return { bearer: data.accessToken, address: wallet.address as Address, privateKey: wallet.privateKey as Hex };
}

async function preflight(bearer: string, actionType: "commit" | "vote", caller: Address) {
  // Vote preflight expects ?voter=; commit uses ?submitter=. Different
  // query param maps to different rate-limit buckets server-side.
  const qparam = actionType === "vote" ? "voter" : "submitter";
  const callerKey = actionType === "vote" ? "voter" : "submitter";
  const res = await fetch(
    `${API}/v1/questions/${qid}/intents/preflight?${qparam}=${caller}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ actionType, params: { [callerKey]: caller } }),
    },
  );
  if (!res.ok) throw new Error(`preflight ${actionType} failed: ${res.status} ${await res.text()}`);
  return res.json() as any;
}

async function listConfirmedSolutions(): Promise<{ id: string; intentHash: Hex; author: Address }[]> {
  // Round 3 doesn't expose a standalone listing surface that returns
  // solution rows. Read directly from the local DB — same query the
  // backend would issue.
  const { Client } = await import("pg");
  const client = new Client({
    host: process.env.RT_PG_HOST || "localhost",
    port: Number(process.env.RT_PG_PORT || "5432"),
    user: process.env.RT_PG_USER || "rezontree",
    password: process.env.RT_PG_PASSWORD || "rezontree",
    database: process.env.RT_PG_DB || "rezontree",
  });
  await client.connect();
  try {
    const r = await client.query<{ id: string; intent_hash: string; author_address: string }>(
      `SELECT s.id,
              encode(s.intent_hash,'hex') AS intent_hash,
              encode(s.author_address,'hex') AS author_address
         FROM solutions s
         JOIN rounds r ON r.id = s.round_id
        WHERE r.question_id = $1
          AND s.confirmation_status = 'confirmed'`,
      [qid],
    );
    return r.rows.map((row) => ({
      id: row.id,
      intentHash: ("0x" + row.intent_hash) as Hex,
      author: ("0x" + row.author_address) as Address,
    }));
  } finally {
    await client.end();
  }
}

async function doSolve() {
  console.log(`\n=== STEP 1: solver (idx ${SOLVER_IDX}) ===`);
  const { bearer, address, privateKey } = await login(SOLVER_IDX);
  console.log(`  solver address: ${address}`);

  const pre = await preflight(bearer, "commit", address);
  console.log(`  preflight: feeAmount=${pre.feeAmount} stakeAmount=${pre.stakeAmount} nonce=${pre.nonce}`);

  const { publicClient, walletClient } = makeClients(privateKey);

  const feeAmount = BigInt(pre.feeAmount);
  const stakeAmount = BigInt(pre.stakeAmount);

  await ensureUsdcAllowance(walletClient, publicClient, {
    usdc: USDC,
    forge: FORGE,
    owner: address,
    required: feeAmount + stakeAmount,
  });
  console.log(`  USDC allowance ok`);

  const solutionBodyJSON = canonicalStringify({
    body: "Diagnostic solution. The protocol's projection columns populate via the reconciler at chain-event time. This solution exists to exercise the SolutionCommitted event so we can observe which DB columns the reconciler does or does not update. Specifically we're testing rounds.first_solution_at, rounds.deadline, questions.solution_count, rounds.solution_count, and the downstream ScheduleSettle River job enqueue. The chain emits a single SolutionCommitted log; ponder projects it; the reconciler must run UPDATE statements against rounds and questions to keep the cached counters in sync with the confirmed-only chain truth. Without those UPDATEs, downstream consumers (AbandonPreconditionsRule, SettleRoundJob enqueue, public list endpoints) observe stale state.",
    reasoningTree: [
      { step: 1, kind: "because", text: "The chain is authoritative; backend mirrors via Ponder." },
      { step: 2, kind: "therefore", text: "Every event needs a projection step in the reconciler." },
      { step: 3, kind: "because", text: "Legacy CreateSolution wrote first_solution_at + deadline inline at INSERT." },
      { step: 4, kind: "therefore", text: "When v2 commit deleted that inline write, the equivalent must move to the reconciler." },
      { step: 5, kind: "because", text: "Otherwise SettleRoundJob can't schedule and AbandonPreconditionsRule misjudges." },
      { step: 6, kind: "therefore", text: "Drift between code (no projection) and tasks (marked complete) is itself a symptom." },
    ],
    claims: [
      {
        criterionId: "criterion-1",
        value: "Reconciler is the canonical projection site",
        argument: "R-RECONCILER-OWNS-CONFIRMATION codifies this; service/vote.go L431-437 declares the contract.",
        falsifiableBy: "Show a production path that writes solutions.total_conviction outside internal/reconciler/ and isn't a legacy dead-code branch.",
      },
    ],
  });

  const expiresAt = BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300);
  const nonce = BigInt(pre.nonce ?? "0");
  const platformFeeRecipient =
    (pre.platformFeeRecipient as Address | undefined) ??
    ("0x0000000000000000000000000000000000000000" as Address);

  const result = await runCommitFlow({
    baseUrl: API,
    bearerToken: bearer,
    signer: address,
    questionId: qid!,
    qid: pre.qid as Hex,
    nonce,
    expiresAt,
    forgeAddress: FORGE,
    chainId: pre.chainId ?? CHAIN_ID,
    solutionBody: solutionBodyJSON,
    references: [],
    token: pre.token.contractAddress as Address,
    feeAmount,
    stakeAmount,
    feeShareBps: 0,
    feeShares: [{ recipient: platformFeeRecipient, basisPoints: 10000 }],
    walletClient,
    privateKey,
  });
  await awaitReceipt(publicClient, result.txHash!);
  console.log(`  ✓ solution broadcast: intentHash=${result.intentHash} tx=${result.txHash}`);
  return { solverAddress: address };
}

async function pollForConfirmedSolution(notFrom: Address): Promise<{ id: string; intentHash: Hex; author: Address }> {
  for (let i = 0; i < 30; i++) {
    const sols = await listConfirmedSolutions();
    const target = sols.find((s) => s.author?.toLowerCase() !== notFrom.toLowerCase());
    if (target) return target;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("no confirmed solution from a non-voter address after 150s");
}

async function doVote(solverAddress: Address) {
  console.log(`\n=== STEP 2: voter (idx ${VOTER_IDX}) — polling for confirmed solution ===`);
  const { bearer, address, privateKey } = await login(VOTER_IDX);
  console.log(`  voter address: ${address}`);

  const target = await pollForConfirmedSolution(address);
  console.log(`  target solution: ${target.id} by ${target.author}`);

  const pre = await preflight(bearer, "vote", address);
  console.log(`  preflight: feeAmount=${pre.feeAmount} stakeAmount=${pre.stakeAmount} voteSalt=${pre.voteSalt?.slice(0, 10)}...`);

  const { publicClient, walletClient } = makeClients(privateKey);

  const feeAmount = BigInt(pre.feeAmount);
  const stakeAmount = BigInt(pre.stakeAmount);

  await ensureUsdcAllowance(walletClient, publicClient, {
    usdc: USDC,
    forge: FORGE,
    owner: address,
    required: feeAmount + stakeAmount,
  });
  console.log(`  USDC allowance ok`);

  const voteSalt = pre.voteSalt as Hex;
  const voteSaltToken = pre.voteSaltToken as string;
  const expiresAt = BigInt(pre.voteSaltExpiresAt);
  const nonce = BigInt(pre.nonce ?? "0");
  const platformFeeRecipient =
    (pre.platformFeeRecipient as Address | undefined) ??
    ("0x0000000000000000000000000000000000000000" as Address);

  // 100 conviction points = 10000 basis points. Chain expects bytes32
  // solutionId — the natural value is the solution's intent_hash, which
  // is what the contract uses to identify the chain artifact.
  const v2Allocations = [
    { solutionId: target.intentHash, basisPoints: 10000 },
  ];

  const result = await runVoteFlow({
    baseUrl: API,
    bearerToken: bearer,
    signer: address,
    questionId: qid!,
    qid: pre.qid as Hex,
    nonce,
    expiresAt,
    forgeAddress: FORGE,
    chainId: pre.chainId ?? CHAIN_ID,
    expectedIntentHash: pre.expectedIntentHash as Hex,
    allocations: v2Allocations,
    voteSalt,
    voteSaltToken,
    token: pre.token.contractAddress as Address,
    feeAmount,
    stakeAmount,
    feeShareBps: 0,
    feeShares: [{ recipient: platformFeeRecipient, basisPoints: 10000 }],
    walletClient,
    privateKey,
  });
  await awaitReceipt(publicClient, result.txHash!);
  console.log(`  ✓ vote broadcast: intentHash=${result.intentHash} tx=${result.txHash}`);
}

(async () => {
  console.log(`drive-solve-vote: question=${qid} forge=${FORGE}`);
  let solverAddress: Address;
  if (process.env.SKIP_SOLVER === "1") {
    console.log("\n=== STEP 1: SKIPPED (SKIP_SOLVER=1) ===");
    solverAddress = "0x0000000000000000000000000000000000000000" as Address;
  } else {
    ({ solverAddress } = await doSolve());
  }
  await doVote(solverAddress);
  console.log(`\n=== done. now run: scripts/diagnose-settle.sh ${qid} ===`);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
