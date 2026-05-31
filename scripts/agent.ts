#!/usr/bin/env tsx
// scripts/agent.ts — one action, one agent, one decision.
//
// This is NOT a battle harness. There are no loops, no scenario lists,
// no orchestration. Each command performs a single deliberate action by
// a single named agent (HD index). Use it the way an agent would reason
// about its own next move: "I'm alice, I want to sponsor this question —
// call agent.ts sponsor --idx 1 --question-file ...".
//
// v1 → v2 rewrite (#595). Every command moved from the removed v1
// per-action chain functions + v1 endpoints to the Quadphase v2 unified-
// envelope model, mirroring the live MCP server:
//   • auth:    /auth/wallet  →  /v1/sessions (WalletLoginIntent).
//   • sponsor: GET /sponsorships/draft + buildSponsorIntent + signUSDCPermit
//              + broadcastSponsor  →  POST /intents/preflight {sponsor} +
//              runSponsorFlow (preflight → sign Envelope(Sponsor) → POST
//              /intents → sponsorSubmit). USDC permit removed (EIP-2612
//              gone); pre-approve via ensureUsdcAllowance.
//   • commit:  /commit + buildCommitIntent + broadcastCommit  →
//              runCommitFlow (submit env).
//   • vote:    /vote-intent + buildVoteIntent + broadcastVote  →
//              runVoteFlow (submit env, voteSalt from preflight).
//   • settle:  client-side merkle + v1 publishSettlement(SettlementIntent)
//              → the backend ORACLE KEEPER owns settlement now. This
//              command AWAITS the keeper (or, with --witness-file, signs +
//              broadcasts a publishSettlement(env,sig,witness) via
//              runSettleFlow). It no longer re-derives the tree.
//   • claim:   claimAllForQuestion  →  the unified withdraw door +
//              runClaimFlow / runRefundFlow (pullValue). Recovers winner
//              payout AND stake/sponsor refunds.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import {
  type Address,
  type Hex,
  createPublicClient,
  fallback,
  http,
  formatUnits,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import {
  ensureUsdcAllowance,
  runCommitFlow,
  runSponsorFlow,
  runVoteFlow,
  runSettleFlow,
} from "../src/forge/quadphase-flow.js";
import { canonicalStringify } from "../src/intents/commit-intent.js";
import { parseAmountToWei } from "../src/intents/amounts.js";
import type { SlashEntry } from "../src/intents/settle-witness.js";
import {
  awaitReceipt,
  makeAgentWalletClient,
} from "../src/forge/quadphase-broadcast.js";
import {
  buildWalletBank,
  loginWallet,
  sweepWalletQuestion,
  type SweepOptions,
} from "./lib/operator-recovery.js";

// ── env + clients ────────────────────────────────────────────────
const RPC_URLS = (process.env.RT_RPC_URLS ?? process.env.RT_RPC_URL ?? "https://sepolia.base.org")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const BACKEND = (process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const USDC = (process.env.RT_USDC_ADDRESS as Address) ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const CHAIN_ID = Number(process.env.RT_AGENT_CHAIN_ID ?? process.env.RT_CHAIN_ID ?? "84532");
if (!FORGE) throw new Error("RT_FORGE_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const transport =
  RPC_URLS.length === 1
    ? http(RPC_URLS[0])
    : fallback(RPC_URLS.map((u) => http(u)), { retryCount: 0 });
const publicClient = createPublicClient({ chain: baseSepolia, transport });

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

// ── helpers ──────────────────────────────────────────────────────

function agentAddress(idx: number): Address {
  return mnemonicToAccount(MNEMONIC, { addressIndex: idx }).address.toLowerCase() as Address;
}

/** Login (POST /v1/sessions) → bearer + address + privateKey for one HD
 *  index. Delegates to the shared loginWallet so auth stays in one place. */
async function login(idx: number): Promise<{ token: string; address: Address; privateKey: Hex }> {
  const { bearer, address, privateKey } = await loginWallet(BACKEND, MNEMONIC, idx);
  return { token: bearer, address, privateKey };
}

/** POST a unified preflight. Returns the parsed JSON (shape varies per
 *  actionType — callers narrow the fields they read). */
async function preflight(
  bearer: string,
  questionId: string,
  actionType: string,
  callerKey: string,
  caller: Address,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${BACKEND}/v1/questions/${questionId}/intents/preflight?${callerKey}=${caller}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ actionType, params: { [callerKey]: caller } }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`preflight ${actionType} → ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function feeShareFromPreflight(pre: Record<string, unknown>): {
  feeShareBps: number;
  feeShares: { recipient: Address; basisPoints: number }[];
  platformFeeRecipient: Address;
} {
  const platformFeeRecipient =
    (pre.platformFeeRecipient as Address | undefined) ?? ZERO_ADDR;
  const feeShareBps = Number(pre.feeShareBps ?? 0);
  const feeShares =
    Array.isArray(pre.feeShares) && pre.feeShares.length > 0
      ? (pre.feeShares as { recipient: string; basisPoints: number }[]).map((s) => ({
          recipient: s.recipient as Address,
          basisPoints: s.basisPoints,
        }))
      : [{ recipient: platformFeeRecipient, basisPoints: 10000 }];
  return { feeShareBps, feeShares, platformFeeRecipient };
}

// ── commands ─────────────────────────────────────────────────────

const program = new Command();
program.name("agent").description("One action, one agent, one decision.");

program
  .command("auth")
  .argument("<idx>", "HD index", (s) => Number.parseInt(s, 10))
  .description("Authenticate as agent <idx> and print JWT.")
  .action(async (idx: number) => {
    const { token, address } = await login(idx);
    console.log(JSON.stringify({ idx, address, token }, null, 2));
  });

program
  .command("sponsor")
  .description("Post + fund a question on chain. Reads question content from --question-file.")
  .requiredOption("--idx <n>", "HD index of the sponsor wallet", (s) => Number.parseInt(s, 10))
  .requiredOption("--question-file <path>", "Path to JSON with title/description/success_criteria")
  .option("--amount <usdc>", "Sponsor amount in USDC (default 1)", "1")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const file = path.resolve(opts.questionFile as string);
    const q = JSON.parse(fs.readFileSync(file, "utf8")) as {
      title: string;
      description: string;
      success_criteria: Array<{ name: string; type: string; target: string; weight: number; description?: string }>;
    };
    console.log(`[agent ${idx}] login...`);
    const me = await login(idx);
    console.log(`  authed as ${me.address}`);

    console.log(`[agent ${idx}] POST /v1/questions ...`);
    const createRes = await fetch(`${BACKEND}/v1/questions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${me.token}` },
      body: JSON.stringify({
        title: q.title,
        description: q.description,
        successCriteria: q.success_criteria.map((sc) => ({
          name: sc.name,
          type: sc.type,
          target: sc.target,
          weight: sc.weight,
        })),
        initialBounty: parseAmountToWei(opts.amount as string, 6).toString(),
        bountyCurrency: "USD",
        tags: ["agent-cli"],
      }),
    });
    if (!createRes.ok) throw new Error(`POST /v1/questions → ${createRes.status} ${await createRes.text()}`);
    const created = (await createRes.json()) as { id: string; qid: string };
    console.log(`  questionId=${created.id}`);

    console.log(`[agent ${idx}] preflight (sponsor) ...`);
    const pre = await preflight(me.token, created.id, "sponsor", "sponsor", me.address);
    if (pre.mode !== "sponsor") throw new Error(`preflight mode=${pre.mode}, expected sponsor`);
    const decimals = (pre.token as { decimals: number }).decimals;
    const amountWei = parseAmountToWei(opts.amount as string, decimals);

    const walletClient = makeAgentWalletClient({ privateKey: me.privateKey, chainId: CHAIN_ID, rpcUrl: RPC_URLS[0] });
    console.log(`[agent ${idx}] ensure USDC allowance ...`);
    await ensureUsdcAllowance(walletClient, publicClient, {
      usdc: USDC,
      forge: FORGE,
      owner: me.address,
      required: amountWei,
    });

    const { feeShareBps, platformFeeRecipient } = feeShareFromPreflight(pre);
    console.log(`[agent ${idx}] runSponsorFlow (preflight → sign → POST /intents → sponsorSubmit) ...`);
    const result = await runSponsorFlow({
      baseUrl: BACKEND,
      bearerToken: me.token,
      signer: me.address,
      questionId: created.id,
      qid: pre.qid as Hex,
      nonce: BigInt((pre.nonce as string) ?? "0"),
      expiresAt: BigInt((pre.recommendedExpiresAt as number) ?? Math.floor(Date.now() / 1000) + 300),
      forgeAddress: FORGE,
      chainId: (pre.chainId as number) ?? CHAIN_ID,
      expectedIntentHash: pre.expectedIntentHash as Hex,
      title: q.title,
      body: q.description,
      criteria: JSON.stringify(q.success_criteria),
      tags: ["agent-cli"],
      oracle: (pre.oracle as Address | undefined) ?? me.address,
      sponsorshipFloor: BigInt((pre.sponsorshipFloor as string) ?? (pre.recommendedSponsorshipFloor as string) ?? "0"),
      commitFee: BigInt((pre.commitFee as string) ?? "0"),
      voteFee: BigInt((pre.voteFee as string) ?? "0"),
      stakeFloor: BigInt((pre.stakeFloor as string) ?? "0"),
      stakeBasisPoints: Number((pre.stakeBasisPoints as string) ?? "0"),
      fundingDeadline: BigInt((pre.recommendedFundingDeadline as string) ?? Math.floor(Date.now() / 1000) + 30 * 86400),
      noSolutionGracePeriod: BigInt((pre.noSolutionGracePeriod as string) ?? "86400"),
      token: (pre.token as { contractAddress: string }).contractAddress as Address,
      amount: amountWei,
      feeAmount: 0n,
      feeShareBps: amountWei > 0n ? feeShareBps : 0,
      feeShares: amountWei > 0n ? [{ recipient: platformFeeRecipient, basisPoints: 10000 }] : [],
      walletClient,
      privateKey: me.privateKey,
    });
    await awaitReceipt(publicClient, result.txHash!);
    console.log(`  tx=${result.txHash} intentHash=${result.intentHash}`);

    console.log("\n=== Sponsor action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address },
      questionId: created.id,
      qid: pre.qid,
      intentHash: result.intentHash,
      amountUsdc: opts.amount,
      tx: result.txHash,
    }, null, 2));
  });

program
  .command("commit")
  .description("Author + commit a solution. Reads payload from --solution-file.")
  .requiredOption("--idx <n>", "HD index of the solver wallet", (s) => Number.parseInt(s, 10))
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .requiredOption("--solution-file <path>", "JSON: { body, reasoningTree, claims }")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const qid = opts.qid as string;
    const file = path.resolve(opts.solutionFile as string);
    const payload = JSON.parse(fs.readFileSync(file, "utf8")) as {
      body: string;
      reasoningTree: Array<{ because: string; therefore: string }>;
      claims: Array<{ criterionId: string; value: unknown; argument: string; falsifiableBy: string }>;
    };
    console.log(`[agent ${idx}] login + commit on ${qid} ...`);
    const me = await login(idx);
    const pre = await preflight(me.token, qid, "commit", "submitter", me.address);

    // H7 / realized-outcome: commit feeAmount is always 0 (the fee is
    // skimmed once at settlement; the chain reverts a non-zero commit
    // fee). runCommitFlow hard-sets it; we mirror 0 locally for the
    // allowance + reporting.
    const feeAmount = 0n;
    const stakeAmount = BigInt(pre.stakeAmount as string);
    const { feeShareBps, feeShares, platformFeeRecipient } = feeShareFromPreflight(pre);

    const walletClient = makeAgentWalletClient({ privateKey: me.privateKey, chainId: CHAIN_ID, rpcUrl: RPC_URLS[0] });
    await ensureUsdcAllowance(walletClient, publicClient, {
      usdc: USDC,
      forge: FORGE,
      owner: me.address,
      required: feeAmount + stakeAmount,
    });

    // CommitWitness.solutionBody mirrors the backend's canonical JSON of
    // the structured body ({body, reasoningTree, claims}).
    const solutionBody = canonicalStringify({
      body: payload.body,
      reasoningTree: payload.reasoningTree,
      claims: payload.claims,
    });

    const result = await runCommitFlow({
      baseUrl: BACKEND,
      bearerToken: me.token,
      signer: me.address,
      questionId: qid,
      qid: pre.qid as Hex,
      nonce: BigInt((pre.nonce as string) ?? "0"),
      expiresAt: BigInt((pre.recommendedExpiresAt as number) ?? Math.floor(Date.now() / 1000) + 300),
      forgeAddress: FORGE,
      chainId: (pre.chainId as number) ?? CHAIN_ID,
      // commit preflight can't pre-compute expectedIntentHash (contentHash
      // is body-derived); runCommitFlow derives it locally.
      solutionBody,
      references: [],
      token: (pre.token as { contractAddress: string }).contractAddress as Address,
      // H7: commit feeAmount is hard-set to 0 inside runCommitFlow
      // (realized-outcome model — fee at settlement, chain reverts
      // "commit:feeAmount-must-be-zero" for non-zero). Don't pass it.
      stakeAmount,
      feeShareBps,
      feeShares: feeShares.length ? feeShares : [{ recipient: platformFeeRecipient, basisPoints: 10000 }],
      walletClient,
      privateKey: me.privateKey,
    });
    await awaitReceipt(publicClient, result.txHash!);
    console.log(`  tx=${result.txHash} intentHash=${result.intentHash}`);

    console.log("\n=== Commit action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address }, qid,
      intentHash: result.intentHash, stakeUsdc: formatUnits(stakeAmount, 6),
      feeUsdc: formatUnits(feeAmount, 6), tx: result.txHash,
    }, null, 2));
  });

program
  .command("vote")
  .description("Cast a vote with conviction allocations.")
  .requiredOption("--idx <n>", "HD index of the voter wallet", (s) => Number.parseInt(s, 10))
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .requiredOption("--vote-file <path>", "JSON: { allocations: [{solutionId, points}] }")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const qid = opts.qid as string;
    const file = path.resolve(opts.voteFile as string);
    const payload = JSON.parse(fs.readFileSync(file, "utf8")) as {
      allocations: { solutionId: string; points: number }[];
    };

    console.log(`[agent ${idx}] login + vote on ${qid} ...`);
    const me = await login(idx);
    const pre = await preflight(me.token, qid, "vote", "voter", me.address);
    if (!pre.voteSalt || !pre.voteSaltToken) {
      throw new Error("vote preflight did not return voteSalt + voteSaltToken");
    }

    // Resolve sol_xxx API ids → bytes32 intentHashes (the on-chain
    // Allocation.solutionId is the committed solution's intentHash).
    const detailRes = await fetch(`${BACKEND}/v1/questions/${qid}?include=solutions`, {
      headers: { authorization: `Bearer ${me.token}` },
    });
    const detail = (await detailRes.json()) as {
      solutions?: { data?: Array<{ id: string; intentHash: string }> };
    };
    const hashBySol = new Map<string, Hex>(
      (detail.solutions?.data ?? []).map((s) => [s.id, s.intentHash as Hex]),
    );
    let bpsSum = 0;
    const allocations = payload.allocations.map((a) => {
      const intentHash = hashBySol.get(a.solutionId);
      if (!intentHash) throw new Error(`solution ${a.solutionId} not found / not confirmed on ${qid}`);
      const basisPoints = a.points * 100;
      bpsSum += basisPoints;
      return { solutionId: intentHash, basisPoints };
    });
    if (bpsSum !== 10000) throw new Error(`allocation points must sum to 100 (got ${bpsSum / 100})`);

    // H7 / realized-outcome: vote feeAmount is always 0 (fee at
    // settlement; chain reverts a non-zero vote fee). runVoteFlow
    // hard-sets it; mirror 0 locally for the allowance + reporting.
    const feeAmount = 0n;
    const stakeAmount = BigInt(pre.stakeAmount as string);
    const { feeShareBps, feeShares, platformFeeRecipient } = feeShareFromPreflight(pre);

    const walletClient = makeAgentWalletClient({ privateKey: me.privateKey, chainId: CHAIN_ID, rpcUrl: RPC_URLS[0] });
    await ensureUsdcAllowance(walletClient, publicClient, {
      usdc: USDC,
      forge: FORGE,
      owner: me.address,
      required: feeAmount + stakeAmount,
    });

    const result = await runVoteFlow({
      baseUrl: BACKEND,
      bearerToken: me.token,
      signer: me.address,
      questionId: qid,
      qid: pre.qid as Hex,
      nonce: BigInt((pre.nonce as string) ?? "0"),
      // expiresAt MUST equal voteSaltExpiresAt — the HMAC binds it.
      expiresAt: BigInt(pre.voteSaltExpiresAt as number),
      forgeAddress: FORGE,
      chainId: (pre.chainId as number) ?? CHAIN_ID,
      expectedIntentHash: pre.expectedIntentHash as Hex,
      allocations,
      voteSalt: pre.voteSalt as Hex,
      voteSaltToken: pre.voteSaltToken as Hex,
      token: (pre.token as { contractAddress: string }).contractAddress as Address,
      // H7: feeAmount hard-set to 0 inside runVoteFlow; don't pass it.
      stakeAmount,
      feeShareBps,
      feeShares: feeShares.length ? feeShares : [{ recipient: platformFeeRecipient, basisPoints: 10000 }],
      walletClient,
      privateKey: me.privateKey,
    });
    await awaitReceipt(publicClient, result.txHash!);
    console.log(`  tx=${result.txHash} intentHash=${result.intentHash}`);

    console.log("\n=== Vote action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address }, qid, intentHash: result.intentHash,
      allocations: payload.allocations, stakeUsdc: formatUnits(stakeAmount, 6),
      feeUsdc: formatUnits(feeAmount, 6), tx: result.txHash,
    }, null, 2));
  });

program
  .command("settle")
  .description(
    "Settle a question. By default AWAITS the backend oracle keeper (which " +
    "owns v2 settlement). With --witness-file, signs + broadcasts " +
    "publishSettlement(env,sig,witness) as the oracle (idx 0) from an " +
    "oracle-computed SettleWitness JSON.",
  )
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .option("--witness-file <path>", "Oracle-computed SettleWitness JSON (manual settle escape hatch)")
  .option("--oracle-idx <n>", "HD index of the oracle wallet (manual settle)", (s) => Number.parseInt(s, 10), 0)
  .option("--wait-seconds <s>", "How long to await the keeper (default 180)", (s) => Number.parseInt(s, 10), 180)
  .action(async (opts) => {
    const qid = opts.qid as string;

    // Resolve the chain bytes32 qid + token from the backend.
    const qDetail = await (await fetch(`${BACKEND}/v1/questions/${qid}`)).json() as {
      qid?: string;
    };
    const qidHex = (qDetail.qid ?? "") as Hex;
    if (!qidHex.startsWith("0x")) throw new Error(`no chain qid for ${qid}`);

    const VIEW_ABI = [
      {
        type: "function", name: "getQuestionScalars", stateMutability: "view",
        inputs: [{ name: "qid", type: "bytes32" }],
        outputs: [
          { name: "token", type: "address" },
          { name: "status", type: "uint8" },
          { name: "poolAmount", type: "uint256" },
          { name: "feeShareSet", type: "bool" },
        ],
      },
    ] as const;
    const STATUS_SETTLED = 3;

    async function chainStatus(): Promise<{ token: Address; status: number; pool: bigint }> {
      const s = (await publicClient.readContract({
        address: FORGE, abi: VIEW_ABI, functionName: "getQuestionScalars", args: [qidHex],
      })) as readonly [Address, number, bigint, boolean];
      return { token: s[0], status: Number(s[1]), pool: s[2] };
    }

    let st = await chainStatus();
    console.log(`[settle] ${qid} status=${st.status} pool=${formatUnits(st.pool, 6)} USDC`);
    if (st.status === STATUS_SETTLED) {
      console.log("  already Settled — nothing to do.");
      return;
    }

    if (opts.witnessFile) {
      // Manual oracle settle from a supplied witness.
      const w = JSON.parse(fs.readFileSync(path.resolve(opts.witnessFile as string), "utf8")) as {
        merkleRoot: string; totalClaimable: string | number;
        // Fee-model rename: feeTotal supersedes dustFolded (economics.md §0).
        feeTotal?: string | number; dustFolded?: string | number;
        slashes?: Array<{ intentHash: string; amount: string | number; role: number }>;
        leafCount: string | number; slashEntryOffset?: string | number; totalSlashEntries?: string | number;
        feeDistributions?: Array<{ recipient: string; amount: string | number }>;
      };
      const oracleIdx = opts.oracleIdx as number;
      const oracle = await login(oracleIdx);
      console.log(`  manual settle as oracle idx=${oracleIdx} (${oracle.address})`);
      const slashes: SlashEntry[] = (w.slashes ?? []).map((s) => ({
        intentHash: s.intentHash as Hex, amount: BigInt(s.amount), role: s.role,
      }));
      const walletClient = makeAgentWalletClient({ privateKey: oracle.privateKey, chainId: CHAIN_ID, rpcUrl: RPC_URLS[0] });
      const result = await runSettleFlow({
        signer: oracle.address,
        qid: qidHex,
        questionId: qid,
        nonce: 0n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 1800),
        forgeAddress: FORGE,
        chainId: CHAIN_ID,
        token: st.token,
        merkleRoot: w.merkleRoot as Hex,
        totalClaimable: BigInt(w.totalClaimable),
        feeTotal: BigInt(w.feeTotal ?? w.dustFolded ?? 0),
        slashes,
        leafCount: BigInt(w.leafCount),
        slashEntryOffset: BigInt(w.slashEntryOffset ?? 0),
        totalSlashEntries: BigInt(w.totalSlashEntries ?? slashes.length),
        feeDistributions: (w.feeDistributions ?? []).map((f) => ({
          recipient: f.recipient as Hex,
          amount: BigInt(f.amount),
        })),
        bearerToken: oracle.token,
        baseUrl: BACKEND,
        walletClient,
        privateKey: oracle.privateKey,
      });
      await awaitReceipt(publicClient, result.txHash!);
      console.log(`  manual settlement published: tx=${result.txHash}`);
      return;
    }

    // Default: await the backend oracle keeper.
    const deadline = Date.now() + (opts.waitSeconds as number) * 1000;
    console.log(`  awaiting backend oracle keeper (≤${opts.waitSeconds}s)…`);
    while (st.status !== STATUS_SETTLED) {
      if (Date.now() >= deadline) {
        throw new Error(
          `still status=${st.status} after ${opts.waitSeconds}s. The backend oracle keeper owns settlement; ` +
            `check its logs, or pass --witness-file to settle manually.`,
        );
      }
      await new Promise((r) => setTimeout(r, 10_000));
      st = await chainStatus();
    }
    console.log("  question reached Settled (keeper published).");
  });

program
  .command("claim")
  .description("Withdraw winnings + stake/sponsor refunds for a settled/abandoned question (unified withdraw door).")
  .requiredOption("--idx <n>", "HD index of the claimant", (s) => Number.parseInt(s, 10))
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const qid = opts.qid as string;
    const me = await login(idx);
    console.log(`[agent ${idx}] withdraw on ${qid} as ${me.address} ...`);

    const bank = buildWalletBank(MNEMONIC, idx + 1, CHAIN_ID);
    const wallet = bank.get(me.address.toLowerCase());
    if (!wallet) throw new Error(`wallet idx=${idx} not in derived bank`);

    const sweepOpts: SweepOptions = {
      apiBase: BACKEND,
      forgeAddress: FORGE,
      rpcUrl: RPC_URLS[0],
      chainId: CHAIN_ID,
      dryRun: false,
    };
    const r = await sweepWalletQuestion(sweepOpts, wallet, me.token, qid);
    if (r.eligibleCount === 0) {
      console.log("  nothing to withdraw on this question.");
      return;
    }
    for (const item of r.items) {
      if (item.status === "broadcast") {
        console.log(`  ✓ ${item.actionType} (${item.role}) ${formatUnits(item.amountWei, 6)} USDC tx=${item.txHash}`);
      } else {
        console.log(`  ✗ ${item.actionType} (${item.role}): ${item.error}`);
      }
    }
    console.log("\n=== Claim/withdraw action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address }, qid,
      eligible: r.eligibleCount,
      withdrawnUsdc: formatUnits(r.totalWithdrawnWei, 6),
      failures: r.failures,
    }, null, 2));
  });

program
  .command("status")
  .description("Show registered agents + balances.")
  .action(async () => {
    const ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
    console.log("idx | address                                    | ETH    | USDC");
    console.log("----+--------------------------------------------+--------+-------");
    for (let i = 0; i <= 10; i++) {
      const address = agentAddress(i);
      const [eth, usdc] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.readContract({ address: USDC, abi: ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      ]);
      console.log(`${String(i).padStart(3)} | ${address} | ${formatUnits(eth, 18).slice(0, 6)} | ${formatUnits(usdc, 6).padStart(5)}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
