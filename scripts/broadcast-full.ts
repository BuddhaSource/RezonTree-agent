#!/usr/bin/env tsx
// broadcast-full.ts — full Model C closure across Fund + Commit + Vote.
//
// Uses three wallets from the operator mnemonic (BIP-44 paths 0/1/2):
//   wallet[0] — questioner + funder (has USDC for the bounty)
//   wallet[1] — solver (needs USDC for the commit bond, 1 USDC floor)
//   wallet[2] — voter (needs only ETH for gas; fee+bond=0)
//
// Why three wallets: backend enforces two distinct role constraints
//   - solver ≠ questioner (the /solutions guard: "cannot submit a
//     solution to your own problem")
//   - voter ≠ solver (vote.go: "cannot vote on your own solution")
//
// Flow:
//   1. All wallets login → JWT.
//   2. w0 creates a problem, funds it on-chain (Router.fund()),
//      poll for contribution confirmed.
//   3. w1 commits a solution — POST /commit, POST /solutions (with
//      intent_hash), permit, Router.commitSolution(), poll solution
//      confirmed.
//   4. w2 casts a vote — POST /vote-intent (writes vote row with
//      intent_hash per loop 0077), permit (value=0), Router.castVote(),
//      poll vote confirmed.
//
// Scope boundary: claim + settle are chain-gated on the oracle
// keeper which is still disabled. This script ends after vote
// confirmation; the round needs oracle-published Merkle root
// before Router.claim() works.

import { execSync } from "node:child_process";
import type { Hex } from "viem";
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
  awaitReceipt,
  broadcastCommit,
  broadcastFund,
  broadcastVote,
  makeAgentWalletClient,
} from "../src/router/client.js";
import { signUSDCPermit } from "../src/router/permit.js";

const BACKEND = process.env.RT_BACKEND_URL ?? "http://localhost:8080";
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = 84532;
const USDC =
  (process.env.RT_USDC_ADDRESS as `0x${string}`) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROUTER = process.env.RT_ROUTER_ADDRESS as `0x${string}` | undefined;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!ROUTER) throw new Error("RT_ROUTER_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

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

async function httpCall<T = unknown>(
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
  address: `0x${string}`;
}

async function login(wallet: AgentWallet): Promise<Authed> {
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain: loadLoginDomain(),
  });
  const r = await httpCall<{ access_token: string; address: `0x${string}` }>(
    "POST",
    "/auth/wallet",
    body,
  );
  return { wallet, token: r.access_token, address: r.address };
}

async function pollDB(query: string, expect: string, label: string, limitSec = 30): Promise<void> {
  // Loop 0078 dropped the WSTailer in favour of HTTPPoller —
  // events land within the poll interval (2s default) + finality
  // lag (we read pre-finality rows; projector writes on first
  // observation). 30s is generous.
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

  // --- Derive 3 wallets from operator mnemonic ---
  const w0 = deriveAgentWallet(MNEMONIC!, 0, CHAIN_ID); // questioner + funder
  const w1 = deriveAgentWallet(MNEMONIC!, 1, CHAIN_ID); // solver
  const w2 = deriveAgentWallet(MNEMONIC!, 2, CHAIN_ID); // voter
  ok(`w0 questioner ${w0.address}`);
  ok(`w1 solver     ${w1.address}`);
  ok(`w2 voter      ${w2.address}`);

  // --- Login all three ---
  log("login");
  const [a0, a1, a2] = await Promise.all([login(w0), login(w1), login(w2)]);
  ok("JWTs acquired");

  // --- Create problem ---
  log("create problem");
  const problem = await httpCall<{
    id: string;
    success_criteria: { id: string }[];
  }>(
    "POST",
    "/v1/problems",
    {
      title: `Full broadcast ${Date.now()}`,
      description: "End-to-end fund+commit+vote on-chain.",
      success_criteria: [
        { name: "primary", type: "boolean", target: "true", weight: 100 },
      ],
      initial_bounty: "0",
    },
    a0.token,
  );
  ok(`problem ${problem.id}`);

  // --- RPC clients ---
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
  const publicClient = createPublicClient({
    chain: walletClient0.chain,
    transport: http(RPC),
  });

  // =========================================================================
  // STEP 1 — FUND (w0)
  // =========================================================================
  log("fund", "w0 → Router.fund()");
  const fundPre = await httpCall<FundPreflight>(
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
  const fundResp = await httpCall<{ intent_hash: string; contribution_id: string }>(
    "POST",
    `/v1/problems/${problem.id}/fund`,
    buildFundRequestBody({ typedData: fundTd, signature: fundSig }),
    a0.token,
  );
  ok(`contribution ${fundResp.contribution_id}`);
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
  await pollDB(
    `SELECT confirmation_status FROM contributions WHERE id = '${fundResp.contribution_id}'`,
    "confirmed",
    "fund",
  );

  // =========================================================================
  // STEP 2 — COMMIT (w1 solver, chained body)
  // =========================================================================
  log("commit", "w1 → Router.commitSolution()");
  const commitPre = await httpCall<CommitPreflight>(
    "GET",
    `/v1/problems/${problem.id}/commit/preflight?submitter=${a1.address}`,
  );
  const solutionBody = "Truth is what survives scrutiny. Loop 0077 broadcast-full test.";
  const contentHash = computeContentHash(solutionBody);
  const commitTd = buildCommitIntentTypedData({
    preflight: commitPre,
    submitter: a1.address,
    contentHash,
  });
  const commitSig = (await privateKeyToAccount(w1.privateKey).signTypedData(commitTd)) as Hex;
  const commitResp = await httpCall<{ intent_hash: string }>(
    "POST",
    `/v1/problems/${problem.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: commitTd, signature: commitSig }),
    a1.token,
  );
  const solutionResp = await httpCall<{ id: string }>(
    "POST",
    `/v1/problems/${problem.id}/solutions`,
    {
      intent_hash: commitResp.intent_hash,
      summary: solutionBody,
      reasoning_tree: [
        {
          because: "Broadcast test exercises loop 0076's intent_hash linkage.",
          therefore: "Projector_solution_committed can match the event back to this row.",
        },
      ],
      claims: [
        {
          criterion_id: problem.success_criteria[0].id,
          value: true,
          argument: "By construction: the script drives the full flow.",
          falsifiable_by: "Projector fails to flip the row.",
        },
      ],
    },
    a1.token,
  );
  ok(`solution ${solutionResp.id}`);

  const commitValue =
    BigInt(commitTd.message.feeAmount) + BigInt(commitTd.message.bondAmount);
  const commitPermit = await signUSDCPermit(walletClient1, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: commitValue,
    deadline: commitTd.message.expiresAt,
  });
  const commitTx = await broadcastCommit(walletClient1, {
    routerAddress: ROUTER!,
    intent: commitTd.message,
    intentSig: commitSig,
    permit: commitPermit,
  });
  info(`commit tx ${commitTx}`);
  await awaitReceipt(publicClient, commitTx);
  await pollDB(
    `SELECT confirmation_status FROM solutions WHERE id = '${solutionResp.id}'`,
    "confirmed",
    "commit",
  );

  // =========================================================================
  // STEP 3 — VOTE (w2)
  // =========================================================================
  log("vote", "w2 → Router.castVote()");
  const votePre = await httpCall<VotePreflight>(
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
  const voteResp = await httpCall<{ intent_hash: string }>(
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

  const voteValue =
    BigInt(voteTd.message.feeAmount) + BigInt(voteTd.message.bondAmount);
  const votePermit = await signUSDCPermit(walletClient2, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: voteValue,
    deadline: voteTd.message.expiresAt,
  });
  const voteTx = await broadcastVote(walletClient2, {
    routerAddress: ROUTER!,
    intent: voteTd.message,
    intentSig: voteSig,
    permit: votePermit,
  });
  info(`vote tx ${voteTx}`);
  await awaitReceipt(publicClient, voteTx);
  await pollDB(
    `SELECT confirmation_status FROM votes WHERE intent_hash = decode('${voteResp.intent_hash.replace(/^0x/, "")}','hex')`,
    "confirmed",
    "vote",
  );

  console.log("");
  console.log(c.green(c.bold("  Fund + Commit + Vote end-to-end: passing.")));
  console.log(c.dim(`  Problem: ${problem.id}`));
  console.log(c.dim("  Settle + Claim remain chain-gated on oracle keeper."));
}

main().catch((err) => {
  console.error(`\n${"\x1b[31m"}[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  process.exit(1);
});
