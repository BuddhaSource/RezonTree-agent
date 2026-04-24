#!/usr/bin/env tsx
// simulate-flow.ts — runs 3 agents through the full intent flow
// against a live backend (no chain broadcast — that step is
// logged but deferred to the operator's Router deploy).
//
// What this validates end-to-end:
//   - Agents derive wallets from one shared mnemonic.
//   - Each agent does POST /auth/wallet and gets a JWT.
//   - Agent-1 creates a problem via POST /v1/problems.
//   - Agent-1 fetches /fund/preflight, signs a FundIntent, POSTs
//     /v1/problems/:id/fund.
//   - Agent-2 fetches /commit/preflight, signs a CommitIntent,
//     POSTs /v1/problems/:id/commit (+ /solutions body).
//   - Agent-3 fetches /vote/preflight, signs a VoteIntent, POSTs
//     /v1/problems/:id/vote-intent with canonical allocations.
//
// What this DOESN'T validate (chain-gated):
//   - Router on-chain verification of intent + permit sigs.
//   - Indexer ingestion (projector rows don't flip to confirmed).
//   - Settlement + claim.
//
// Any failure surfaces the backend's `action` string verbatim
// (errors-as-documentation). Exit 0 on full success; exit 1 on
// any step failure.

import { generateMnemonic, english, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { deriveAgentWallets } from "../src/wallet/derive.js";
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
  buildSubmitVoteIntentRequestBody,
  buildVoteIntentTypedData,
  computeAllocationsHash,
  type Allocation,
} from "../src/intents/vote-intent.js";
import type {
  CommitPreflight,
  FundPreflight,
  VotePreflight,
} from "../src/intents/preflight-types.js";

const BACKEND = process.env.RT_BACKEND_URL ?? "http://localhost:8080";
const CHAIN_ID = 84532;

// Color helpers for readable simulation output.
const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function log(step: string, detail?: string) {
  const s = c.cyan(`[${step}]`);
  if (detail) console.log(`${s} ${detail}`);
  else console.log(s);
}
function ok(detail: string) {
  console.log(`  ${c.green("✓")} ${detail}`);
}
function warn(detail: string) {
  console.log(`  ${c.yellow("⚠")} ${detail}`);
}
function fail(detail: string) {
  console.log(`  ${c.red("✗")} ${detail}`);
}

/** Fetch wrapper that surfaces the backend's `action` field on
 *  4xx/5xx so simulation output reads like real agent UX. */
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
    const msg = err?.message ?? raw;
    const action = err?.action ? ` — ${err.action}` : "";
    throw new Error(`${method} ${path} → ${res.status}: ${msg}${action}`);
  }
  return parsed as T;
}

interface AuthedAgent {
  wallet: AgentWallet;
  token: string;
  address: `0x${string}`;
}

async function loginAgent(wallet: AgentWallet): Promise<AuthedAgent> {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const body = await signWalletLoginIntent({ wallet, expiresAt });
  const resp = await call<{ access_token: string; address: `0x${string}` }>(
    "POST",
    "/auth/wallet",
    body,
  );
  return { wallet, token: resp.access_token, address: resp.address };
}

async function main() {
  log("simulate", c.bold(`→ backend ${BACKEND} | chain ${CHAIN_ID}`));

  // Step 1 — provision three wallets from a fresh mnemonic.
  log("1/7", "provisioning 3 agents from fresh mnemonic");
  const mnemonic = generateMnemonic(english);
  const wallets = deriveAgentWallets(mnemonic, 3, CHAIN_ID);
  const [questioner, solver, voter] = wallets;
  ok(`questioner ${questioner.address}`);
  ok(`solver     ${solver.address}`);
  ok(`voter      ${voter.address}`);

  // Step 2 — each agent authenticates (POST /auth/wallet).
  log("2/7", "wallet login (EIP-712 → /auth/wallet)");
  const [q, s, v] = await Promise.all([
    loginAgent(questioner),
    loginAgent(solver),
    loginAgent(voter),
  ]);
  ok(`questioner JWT acquired`);
  ok(`solver JWT acquired`);
  ok(`voter JWT acquired`);

  // Step 3 — questioner creates a problem.
  log("3/7", "questioner creates a problem");
  const problem = await call<{
    id: string;
    title: string;
    success_criteria: { id: string; name: string }[];
  }>(
    "POST",
    "/v1/problems",
    {
      title: `Sim problem ${Date.now()}`,
      description:
        "Simulation problem generated by scripts/simulate-flow.ts",
      success_criteria: [
        {
          name: "correct-answer",
          type: "boolean",
          target: "true",
          weight: 100,
        },
      ],
      initial_bounty: "0",
    },
    q.token,
  );
  ok(`problem ${problem.id} — "${problem.title}"`);

  // Step 4 — questioner funds (preflight → sign → POST).
  log("4/7", "questioner funds (preflight → sign → POST /fund)");
  const fundPre = await call<FundPreflight>(
    "GET",
    `/v1/problems/${problem.id}/fund/preflight?funder=${q.address}`,
  );
  ok(
    `preflight: qid ${fundPre.qid.slice(0, 10)}…, router ${fundPre.router_address.slice(0, 10)}…, nonce_next ${fundPre.nonce_next}`,
  );

  const fundAccount = privateKeyToAccount(questioner.privateKey);
  const fundTd = buildFundIntentTypedData({
    preflight: fundPre,
    funder: q.address,
    amountWei: parseAmountToWei("5", fundPre.token.decimals),
  });
  const fundSig = (await fundAccount.signTypedData(fundTd)) as Hex;
  const fundResp = await call<{ intent_hash: string; contribution_id: string }>(
    "POST",
    `/v1/problems/${problem.id}/fund`,
    buildFundRequestBody({ typedData: fundTd, signature: fundSig }),
    q.token,
  );
  ok(`fund intent_hash ${fundResp.intent_hash.slice(0, 10)}…`);
  ok(`contribution ${fundResp.contribution_id}`);
  warn(
    "on-chain Router.fund() NOT called (requires operator Router deploy). Backend row is pending until indexer sees QuestionFunded.",
  );

  // Step 5 — solver commits (preflight → sign → POST + body).
  log("5/7", "solver commits solution");
  const commitPre = await call<CommitPreflight>(
    "GET",
    `/v1/problems/${problem.id}/commit/preflight?submitter=${s.address}`,
  );
  ok(
    `preflight: nonce_next ${commitPre.nonce_next}, fee floor ${commitPre.recommended_fee}, bond floor ${commitPre.recommended_bond}`,
  );

  const solutionBody =
    "42 is the answer, per deep-thought's 7.5M-year computation.";
  const contentHash = computeContentHash(solutionBody);
  const solverAccount = privateKeyToAccount(solver.privateKey);
  const commitTd = buildCommitIntentTypedData({
    preflight: commitPre,
    submitter: s.address,
    contentHash,
  });
  const commitSig = (await solverAccount.signTypedData(commitTd)) as Hex;
  const commitResp = await call<{ intent_hash: string; status: string }>(
    "POST",
    `/v1/problems/${problem.id}/commit`,
    buildSubmitCommitRequestBody({ typedData: commitTd, signature: commitSig }),
    s.token,
  );
  ok(`commit intent_hash ${commitResp.intent_hash.slice(0, 10)}…`);

  // Also POST the body (loop 0071 chained flow).
  const solutionResp = await call<{ id: string; summary: string }>(
    "POST",
    `/v1/problems/${problem.id}/solutions`,
    {
      summary: solutionBody,
      reasoning_tree: [
        {
          because:
            "Deep Thought computed the Ultimate Question for 7.5M years.",
          therefore:
            "Its output, 42, is the canonical answer.",
        },
      ],
      claims: [
        {
          criterion_id: problem.success_criteria[0].id,
          value: true,
          argument: "Reference to Hitchhiker's Guide",
          falsifiable_by: "Different computation yields different answer",
        },
      ],
    },
    s.token,
  );
  ok(`solution body posted — id ${solutionResp.id}`);
  warn(
    "on-chain Router.commitSolution() NOT called (operator deploy pending).",
  );

  // Step 6 — voter casts (preflight → allocations → sign → POST).
  log("6/7", "voter casts vote");
  const votePre = await call<VotePreflight>(
    "GET",
    `/v1/problems/${problem.id}/vote/preflight?voter=${v.address}`,
  );
  ok(
    `preflight: nonce_next ${votePre.nonce_next}, fee floor ${votePre.recommended_fee}, bond floor ${votePre.recommended_bond}`,
  );

  const allocations: Allocation[] = [
    { solution_id: solutionResp.id, points: 100 },
  ];
  const allocationsHash = computeAllocationsHash(allocations);
  const voterAccount = privateKeyToAccount(voter.privateKey);
  const voteTd = buildVoteIntentTypedData({
    preflight: votePre,
    voter: v.address,
    allocationsHash,
  });
  const voteSig = (await voterAccount.signTypedData(voteTd)) as Hex;
  const voteResp = await call<{ intent_hash: string; status: string }>(
    "POST",
    `/v1/problems/${problem.id}/vote-intent`,
    buildSubmitVoteIntentRequestBody({
      typedData: voteTd,
      allocations,
      signature: voteSig,
    }),
    v.token,
  );
  ok(`vote intent_hash ${voteResp.intent_hash.slice(0, 10)}…`);
  warn(
    "on-chain Router.castVote() NOT called. Settle + claim are chain-gated too.",
  );

  // Step 7 — report.
  log("7/7", c.bold("simulation complete"));
  console.log("");
  console.log(
    c.green(
      "  All 3 agents signed + POSTed their intents successfully against the live backend.",
    ),
  );
  console.log(
    c.dim(
      "  Signature recovery, canonical-hash parity, nonce + TTL — all validated through backend response codes.",
    ),
  );
  console.log(c.dim("  Chain broadcast deferred to operator Router deploy."));
  console.log("");
  console.log(c.bold("  To check backend state for this run:"));
  console.log(
    c.dim(
      `    docker exec rezontree-postgres-1 psql -U rezontree -d rezontree \\\n      -c "SELECT id, confirmation_status FROM contributions WHERE round_id IN (SELECT id FROM rounds WHERE problem_id = '${problem.id}');"`,
    ),
  );
}

main().catch((err) => {
  console.error(c.red(`\n[FAIL] ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});
