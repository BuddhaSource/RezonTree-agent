#!/usr/bin/env tsx
// scripts/agent.ts — one action, one agent, one decision.
//
// This is NOT a battle harness. There are no loops, no scenario lists,
// no orchestration. Each command performs a single deliberate action
// by a single named agent (HD index). Use it the way an agent would
// reason about its own next move: "I'm alice, I want to sponsor this
// question — call agent.ts sponsor --idx 1 --question-file ...".
//
// Subcommands:
//   auth     <idx>                                — login, print JWT
//   sponsor  <idx> --question-file path.json     — post + fund a question
//   commit   <idx> --qid ... --solution-file p   — author + commit a solution
//   vote     <idx> --qid ... --vote-file p       — cast a conviction allocation
//   claim    <idx> --qid ...                     — claim winnings + stake refunds
//   status                                        — current agent set + balances
//
// All actions use the API + chain. No direct DB writes.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  parseUnits,
  formatUnits,
  keccak256,
  toBytes,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import {
  buildSponsorIntentTypedData,
  buildSponsorFundRequestBody,
  parseAmountToWei,
} from "../src/intents/sponsor-intent.js";
import {
  buildCommitIntentTypedData,
  buildSubmitCommitRequestBody,
  computeContentHash,
} from "../src/intents/commit-intent.js";
import {
  buildVoteIntentTypedData,
  buildSubmitVoteIntentRequestBody,
  computeAllocationsHash,
  validateAllocations,
  type Allocation,
} from "../src/intents/vote-intent.js";
import {
  buildSettlementIntentTypedData,
  DEFAULT_SETTLEMENT_TTL_SECONDS,
} from "../src/intents/settlement-intent.js";
import {
  type MerkleLeaf,
  hashLeaf,
  merkleRoot,
  merkleProof,
} from "../src/intents/merkle.js";
import {
  broadcastSponsor,
  broadcastCommit,
  broadcastVote,
  broadcastClaim,
  broadcastPublishSettlement,
} from "../src/forge/client.js";
import { signUSDCPermit } from "../src/forge/permit.js";
import { REZON_FORGE_ABI } from "../src/forge/abi.js";

// ── env + clients ────────────────────────────────────────────────
// Multi-RPC: RT_RPC_URLS accepts a comma-separated list. viem's
// `fallback` transport rotates on transport-level errors. Falls back
// to single-URL RT_RPC_URL for backwards compatibility, then to the
// public Coinbase endpoint as a last resort.
const RPC_URLS = (process.env.RT_RPC_URLS ?? process.env.RT_RPC_URL ?? "https://sepolia.base.org")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const BACKEND = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const USDC = (process.env.RT_USDC_ADDRESS as Address) ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
if (!FORGE) throw new Error("RT_FORGE_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const transport =
  RPC_URLS.length === 1
    ? http(RPC_URLS[0])
    : fallback(RPC_URLS.map((u) => http(u)), { retryCount: 0 });
const publicClient = createPublicClient({ chain: baseSepolia, transport });

const CONSUMED_NONCES_ABI = [
  {
    type: "function",
    name: "consumedNonces",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Read the lowest unused nonce for `signer` directly from the chain.
 *  The backend's preflight returns its DB-derived nonce_next, which
 *  desyncs after a DB reset while the chain remembers consumed
 *  nonces forever. Always source-of-truth nonces from chain. */
async function chainNextUnusedNonce(signer: Address): Promise<bigint> {
  for (let word = 0n; word < 100n; word++) {
    const bitmap = (await publicClient.readContract({
      address: FORGE,
      abi: CONSUMED_NONCES_ABI,
      functionName: "consumedNonces",
      args: [signer, word],
    })) as bigint;
    const FULL = (1n << 256n) - 1n;
    if (bitmap === FULL) continue;
    for (let i = 0n; i < 256n; i++) {
      if (((bitmap >> i) & 1n) === 0n) return word * 256n + i;
    }
  }
  throw new Error(`no unused nonce found for ${signer} (impossibly hot wallet)`);
}

// ── helpers ──────────────────────────────────────────────────────

function makeAgent(idx: number): { address: Address; privateKey: Hex; account: ReturnType<typeof mnemonicToAccount> } {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: idx });
  // viem doesn't expose private key directly from mnemonicToAccount;
  // derive it ourselves via getHdKey
  const hdKey = account.getHdKey();
  const pk = ("0x" + Buffer.from(hdKey.privateKey!).toString("hex")) as Hex;
  return { address: account.address.toLowerCase() as Address, privateKey: pk, account };
}

function makeWalletClient(idx: number) {
  const { privateKey } = makeAgent(idx);
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: baseSepolia,
    transport,
  });
}

async function callAPI<T = unknown>(
  method: "GET" | "POST",
  pathStr: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const r = await fetch(`${BACKEND}${pathStr}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!r.ok) {
    throw new Error(`${method} ${pathStr} → ${r.status} ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function login(idx: number): Promise<{ token: string; address: Address }> {
  const { address, privateKey } = makeAgent(idx);
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min
  const domain = loadLoginDomain();
  const signed = await signWalletLoginIntent({
    wallet: {
      agentIndex: idx,
      address,
      privateKey,
      chainId: domain.chainId,
    },
    expiresAt,
    domain,
  });
  const r = await callAPI<{ access_token: string; address: string }>(
    "POST",
    "/auth/wallet",
    { address, chain_id: domain.chainId, expires_at: expiresAt, signature: signed.signature },
  );
  return { token: r.access_token, address: address };
}

async function awaitReceipt(hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`tx ${hash} reverted (status=${receipt.status})`);
  }
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
  .option("--expiry-seconds <s>", "Intent TTL in seconds (caps fundingDeadline; chain max ~900s)", "900")
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
    const created = await callAPI<{ id: string }>(
      "POST",
      "/v1/questions",
      {
        title: q.title,
        description: q.description,
        success_criteria: q.success_criteria.map((sc) => ({
          name: sc.name,
          type: sc.type,
          target: sc.target,
          weight: sc.weight,
        })),
        initial_bounty: "0",
      },
      me.token,
    );
    console.log(`  question_id=${created.id}`);

    console.log(`[agent ${idx}] GET fund/preflight ...`);
    const pre = await callAPI<{
      mode: string;
      qid: string;
      token: { address: string; decimals: number };
      forge_address: string;
      oracle: string;
      [k: string]: unknown;
    }>("GET", `/v1/questions/${created.id}/fund/preflight?funder=${me.address}`);
    if (pre.mode !== "sponsor") {
      throw new Error(`preflight mode=${pre.mode}, expected sponsor`);
    }
    console.log(`  preflight ok (mode=${pre.mode}, qid=${pre.qid})`);

    const amountWei = parseAmountToWei(opts.amount as string, pre.token.decimals);

    console.log(`[agent ${idx}] sign SponsorIntent ...`);
    // The contract guard requires a non-empty feeShares array even
    // when feeShareBps=0 (the array shape is hashed into the EIP-712
    // digest). Route to the configured platform fee wallet — index 3
    // (carol) in our pool, matching the existing battle harness.
    const feeWalletIdx = Number.parseInt(process.env.RT_FEE_WALLET_IDX ?? "3", 10);
    const feeWallet = makeAgent(feeWalletIdx).address;

    // Read nonce from chain (backend preflight's DB nonce desyncs
    // after a DB reset; chain bitmap is the source of truth).
    const chainNonce = await chainNextUnusedNonce(me.address);
    console.log(`  chain says next unused nonce = ${chainNonce}`);

    const ttlSec = Number.parseInt(opts.expirySeconds as string, 10);
    const td = buildSponsorIntentTypedData({
      preflight: pre as never,
      sponsor: me.address,
      amountWei,
      feeShareBps: 0n,
      feeShares: [{ recipient: feeWallet, basisPoints: 10000n }],
      nonce: chainNonce,
      expiresAtSeconds: Math.floor(Date.now() / 1000) + ttlSec,
    });
    console.log(`  intent TTL = ${ttlSec}s (fundingDeadline = sponsor's expiresAt)`);
    const wallet = makeWalletClient(idx);
    const intentSig = (await wallet.account.signTypedData(td)) as Hex;

    console.log(`[agent ${idx}] POST /v1/questions/${created.id}/fund (intent + body) ...`);
    const fundResp = await callAPI<{ contribution_id: string }>(
      "POST",
      `/v1/questions/${created.id}/fund`,
      buildSponsorFundRequestBody({ typedData: td, signature: intentSig }),
      me.token,
    );
    console.log(`  contribution_id=${fundResp.contribution_id}`);

    console.log(`[agent ${idx}] sign USDC permit ...`);
    const permit = await signUSDCPermit(wallet, publicClient, {
      usdc: USDC,
      spender: FORGE,
      value: amountWei,
      deadline: td.message.expiresAt,
    });

    console.log(`[agent ${idx}] broadcast sponsor() on chain ...`);
    const tx = await broadcastSponsor(wallet, {
      forgeAddress: FORGE,
      intent: td.message,
      intentSig,
      permit,
    });
    console.log(`  tx=${tx}`);
    await awaitReceipt(tx);
    console.log(`  receipt status=success`);

    console.log("\n=== Sponsor action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address },
      question_id: created.id,
      qid: pre.qid,
      contribution_id: fundResp.contribution_id,
      amount_usdc: opts.amount,
      tx,
    }, null, 2));
  });

program
  .command("commit")
  .description("Author + commit a solution. Reads payload from --solution-file.")
  .requiredOption("--idx <n>", "HD index of the solver wallet", (s) => Number.parseInt(s, 10))
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .requiredOption("--solution-file <path>", "JSON: { body, reasoning_tree, claims }")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const qid = opts.qid as string;
    const file = path.resolve(opts.solutionFile as string);
    const payload = JSON.parse(fs.readFileSync(file, "utf8")) as {
      body: string;
      reasoning_tree: Array<{ because: string; therefore: string }>;
      claims: Array<{ criterion_id: string; value: unknown; argument: string; falsifiable_by: string }>;
    };
    console.log(`[agent ${idx}] login + commit on ${qid} ...`);
    const me = await login(idx);
    const pre = await callAPI<{
      qid: string; recommended_fee: string; recommended_stake: string;
      token: { contract_address: string; decimals: number; symbol: string; chain_id: number };
      forge_address: string; chain_id: number; nonce_next: string;
      [k: string]: unknown;
    }>("GET", `/v1/questions/${qid}/commit/preflight?submitter=${me.address}`);
    // commit preflight doesn't have a mode discriminator (unlike fund/preflight)

    const contentHash = computeContentHash(payload);
    const chainNonce = await chainNextUnusedNonce(me.address);
    console.log(`  chain nonce=${chainNonce}, contentHash=${contentHash}`);

    const feeWalletIdx = Number.parseInt(process.env.RT_FEE_WALLET_IDX ?? "3", 10);
    const feeWallet = makeAgent(feeWalletIdx).address;

    const td = buildCommitIntentTypedData({
      preflight: pre as never,
      submitter: me.address,
      contentHash,
      feeShareBps: 0n,
      feeShares: [{ recipient: feeWallet, basisPoints: 10000n }],
      nonce: chainNonce,
    });
    const wallet = makeWalletClient(idx);
    const intentSig = (await wallet.account.signTypedData(td)) as Hex;

    const intentResp = await callAPI<{ intent_hash: string }>(
      "POST",
      `/v1/questions/${qid}/commit`,
      buildSubmitCommitRequestBody({ typedData: td, signature: intentSig }),
      me.token,
    );
    console.log(`  intent_hash=${intentResp.intent_hash}`);

    const solResp = await callAPI<{ id: string }>(
      "POST",
      `/v1/questions/${qid}/solutions`,
      { intent_hash: intentResp.intent_hash, ...payload },
      me.token,
    );
    console.log(`  solution_id=${solResp.id}`);

    const fee = BigInt(td.message.feeAmount);
    const stake = BigInt(td.message.stakeAmount);
    const permit = await signUSDCPermit(wallet, publicClient, {
      usdc: USDC, spender: FORGE, value: fee + stake, deadline: td.message.expiresAt,
    });
    const tx = await broadcastCommit(wallet, {
      forgeAddress: FORGE, intent: td.message, intentSig, permit,
    });
    console.log(`  tx=${tx}`);
    await awaitReceipt(tx);
    console.log(`  receipt status=success`);

    console.log("\n=== Commit action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address }, qid, solution_id: solResp.id,
      intent_hash: intentResp.intent_hash, stake_usdc: formatUnits(stake, 6),
      fee_usdc: formatUnits(fee, 6), tx,
    }, null, 2));
  });

program
  .command("vote")
  .description("Cast a vote with conviction allocations.")
  .requiredOption("--idx <n>", "HD index of the voter wallet", (s) => Number.parseInt(s, 10))
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .requiredOption("--vote-file <path>", "JSON: { allocations: [{solution_id, points}] }")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const qid = opts.qid as string;
    const file = path.resolve(opts.voteFile as string);
    const payload = JSON.parse(fs.readFileSync(file, "utf8")) as { allocations: Allocation[] };
    validateAllocations(payload.allocations);

    console.log(`[agent ${idx}] login + vote on ${qid} ...`);
    const me = await login(idx);
    const pre = await callAPI<{
      qid: string; recommended_fee: string; recommended_stake: string;
      token: { contract_address: string; decimals: number; symbol: string; chain_id: number };
      forge_address: string; chain_id: number; nonce_next: string;
      vote_salt: string; vote_salt_token: string; vote_salt_expires_at: number;
      [k: string]: unknown;
    }>("GET", `/v1/questions/${qid}/vote/preflight?voter=${me.address}`);
    // vote preflight has no `mode` discriminator

    const allocationsHash = computeAllocationsHash(payload.allocations, pre.vote_salt as `0x${string}`);
    const chainNonce = await chainNextUnusedNonce(me.address);
    console.log(`  chain nonce=${chainNonce}, allocationsHash=${allocationsHash}`);

    const feeWalletIdx = Number.parseInt(process.env.RT_FEE_WALLET_IDX ?? "3", 10);
    const feeWallet = makeAgent(feeWalletIdx).address;

    const td = buildVoteIntentTypedData({
      preflight: pre as never,
      voter: me.address,
      allocationsHash,
      feeShareBps: 0n,
      feeShares: [{ recipient: feeWallet, basisPoints: 10000n }],
      expiresAtSeconds: pre.vote_salt_expires_at,
      nonce: chainNonce,
    });
    const wallet = makeWalletClient(idx);
    const intentSig = (await wallet.account.signTypedData(td)) as Hex;

    const voteResp = await callAPI<{ intent_hash: string }>(
      "POST",
      `/v1/questions/${qid}/vote-intent`,
      buildSubmitVoteIntentRequestBody({
        typedData: td, allocations: payload.allocations, signature: intentSig,
        voteSalt: pre.vote_salt as `0x${string}`, voteSaltToken: pre.vote_salt_token,
      }),
      me.token,
    );
    console.log(`  intent_hash=${voteResp.intent_hash}`);

    const fee = BigInt(td.message.feeAmount);
    const stake = BigInt(td.message.stakeAmount);
    const permit = await signUSDCPermit(wallet, publicClient, {
      usdc: USDC, spender: FORGE, value: fee + stake, deadline: td.message.expiresAt,
    });
    const tx = await broadcastVote(wallet, {
      forgeAddress: FORGE, intent: td.message, intentSig, permit,
    });
    console.log(`  tx=${tx}`);
    await awaitReceipt(tx);
    console.log(`  receipt status=success`);

    console.log("\n=== Vote action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address }, qid, intent_hash: voteResp.intent_hash,
      allocations: payload.allocations, stake_usdc: formatUnits(stake, 6),
      fee_usdc: formatUnits(fee, 6), tx,
    }, null, 2));
  });

program
  .command("settle")
  .description(
    "Publish the settlement Merkle root as the oracle (idx 0). The harness " +
    "uses a simple winner-takes-all-with-platform-fee Merkle tree by default.",
  )
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .requiredOption("--winner-idx <n>", "HD index of the winning solver", (s) => Number.parseInt(s, 10))
  .option("--platform-fee-bps <bps>", "Platform fee basis points (default 1000 = 10%)", "1000")
  .action(async (opts) => {
    const qid = opts.qid as string;
    const winnerIdx = opts.winnerIdx as number;
    const feeBps = BigInt(opts.platformFeeBps);

    const oracle = makeAgent(0);
    const winner = makeAgent(winnerIdx);
    const feeWalletIdx = Number.parseInt(process.env.RT_FEE_WALLET_IDX ?? "3", 10);
    const feeWallet = makeAgent(feeWalletIdx).address;

    console.log(`[oracle 0] settle ${qid}, winner=idx${winnerIdx} (${winner.address}) ...`);

    // Read on-chain qid + pool from DB (we mapped qid via DB insert).
    const dbQid = await callAPI<{ id: string; chain?: { qid?: string } }>(
      "GET",
      `/v1/questions/${qid}`,
    );
    // Read pool amount from chain.
    const QSTATE_ABI = [{
      type: "function", name: "questions", stateMutability: "view",
      inputs: [{ type: "bytes32" }],
      outputs: [
        { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "address" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint256" },
      ],
    }] as const;
    // Get qid bytes32 from API or DB.
    // The chain qid is keccak(question_id_string). The intent stores it.
    // We can simply read from the database table.
    // Get qid bytes32 from the API top-level `qid` field.
    const qDetail = await callAPI<{ qid?: string }>("GET", `/v1/questions/${qid}`);
    const qidHex = (qDetail.qid ?? "") as `0x${string}`;
    if (!qidHex.startsWith("0x")) throw new Error(`no chain qid for ${qid}`);
    void dbQid;

    const qState = (await publicClient.readContract({
      address: FORGE, abi: QSTATE_ABI, functionName: "questions", args: [qidHex],
    })) as readonly [number, Address, Address, Address, bigint, bigint, bigint, bigint, bigint, number, bigint, bigint, bigint, bigint];
    const poolAmount = qState[11];
    console.log(`  poolAmount=${formatUnits(poolAmount, 6)} USDC`);
    if (poolAmount === 0n) throw new Error("pool is empty — cannot settle");

    const feeAmount = (poolAmount * feeBps) / 10000n;
    const winnerAmount = poolAmount - feeAmount;
    const leaves: MerkleLeaf[] = [
      { questionId: qidHex, recipient: winner.address as `0x${string}`, amount: winnerAmount },
      { questionId: qidHex, recipient: feeWallet, amount: feeAmount },
    ];
    const root = merkleRoot(leaves);
    const winnerProof = merkleProof(leaves.map(hashLeaf), 0);

    const td = buildSettlementIntentTypedData({
      forgeAddress: FORGE,
      chainId: BigInt(baseSepolia.id),
      questionId: qidHex,
      merkleRoot: root,
      totalClaimable: poolAmount,
      sampleRecipient: winner.address as `0x${string}`,
      sampleAmount: winnerAmount,
      sampleProof: winnerProof,
      slashedCommitHashes: [],
      slashedVoteHashes: [],
      expiresAtSeconds: Math.floor(Date.now() / 1000) + DEFAULT_SETTLEMENT_TTL_SECONDS,
    });
    const oracleSig = (await privateKeyToAccount(oracle.privateKey).signTypedData(td)) as Hex;
    const oracleWallet = makeWalletClient(0);
    const tx = await broadcastPublishSettlement(oracleWallet, {
      forgeAddress: FORGE,
      questionId: qidHex,
      merkleRoot: root,
      totalClaimable: poolAmount,
      sampleRecipient: winner.address as `0x${string}`,
      sampleAmount: winnerAmount,
      sampleProof: winnerProof,
      expiresAt: td.message.expiresAt,
      slashedCommitHashes: [],
      slashedVoteHashes: [],
      oracleSig,
    });
    console.log(`  tx=${tx}`);
    await awaitReceipt(tx);
    console.log(`  receipt status=success`);

    console.log("\n=== Settle action complete ===");
    console.log(JSON.stringify({
      qid, qidHex, root, poolAmount: formatUnits(poolAmount, 6),
      winner: { idx: winnerIdx, address: winner.address, amount: formatUnits(winnerAmount, 6) },
      feeWallet: { address: feeWallet, amount: formatUnits(feeAmount, 6) },
      tx,
    }, null, 2));
  });

program
  .command("claim")
  .description("Claim winnings + stake refunds for a settled question.")
  .requiredOption("--idx <n>", "HD index of the claimant", (s) => Number.parseInt(s, 10))
  .requiredOption("--qid <id>", "question_id (qst_...)")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const qid = opts.qid as string;
    const me = await login(idx);
    console.log(`[agent ${idx}] claim on ${qid} as ${me.address} ...`);

    // Pool manifest (may be empty if not a winner).
    const manifest = await callAPI<{
      amount: string; currency: string; merkle_root: string | null; proof: string[];
      role: string;
    } | { error: { code: string } }>(
      "GET", `/v1/questions/${qid}/claims/${me.address}`,
    ).catch(() => null);
    let poolAmount = 0n;
    let poolProof: `0x${string}`[] = [];
    if (manifest && "amount" in manifest && manifest.amount && manifest.proof?.length) {
      poolAmount = BigInt(manifest.amount);
      poolProof = manifest.proof as `0x${string}`[];
      console.log(`  pool: ${formatUnits(poolAmount, 6)} USDC, role=${manifest.role}`);
    } else {
      console.log(`  pool: nothing to claim (role=${(manifest as { role?: string })?.role ?? "none"})`);
    }

    // Stake intent_hash discovery.
    const ZERO = ("0x" + "0".repeat(64)) as `0x${string}`;
    let solHash = ZERO;
    let voteHash = ZERO;
    try {
      const sols = await callAPI<{ data: Array<{ id: string; intent_hash?: string; author_address: string }> }>(
        "GET", `/v1/questions/${qid}/solutions?author_address=${me.address}`,
      );
      const mySol = sols.data?.find((s) => s.author_address?.toLowerCase() === me.address);
      if (mySol?.intent_hash) {
        solHash = mySol.intent_hash as `0x${string}`;
        console.log(`  solution intent_hash=${solHash}`);
      }
    } catch (e) {
      console.log(`  solution lookup skipped: ${(e as Error).message}`);
    }
    try {
      const v = await callAPI<{ intent_hash?: string; has_voted?: boolean }>(
        "GET", `/v1/me/votes/${qid}`, undefined, me.token,
      );
      if (v.has_voted && v.intent_hash) {
        voteHash = v.intent_hash as `0x${string}`;
        console.log(`  vote intent_hash=${voteHash}`);
      }
    } catch (e) {
      console.log(`  vote lookup skipped: ${(e as Error).message}`);
    }

    if (poolAmount === 0n && solHash === ZERO && voteHash === ZERO) {
      console.log("  nothing to claim. exiting.");
      return;
    }

    // Fetch chain qid bytes32 via API.
    const qDetail = await callAPI<{ qid?: string }>("GET", `/v1/questions/${qid}`);
    const qidHex = (qDetail.qid ?? "") as `0x${string}`;
    if (!qidHex.startsWith("0x")) throw new Error(`no chain qid for ${qid}`);

    const wallet = makeWalletClient(idx);
    console.log(`[agent ${idx}] broadcast claimAllForQuestion ...`);
    const tx = await wallet.writeContract({
      address: FORGE,
      abi: REZON_FORGE_ABI,
      functionName: "claimAllForQuestion",
      args: [qidHex, poolAmount, poolProof, solHash, voteHash],
      account: wallet.account!,
      chain: wallet.chain,
    });
    console.log(`  tx=${tx}`);
    await awaitReceipt(tx);
    console.log(`  receipt status=success`);

    console.log("\n=== Claim action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address }, qid,
      legs: {
        pool: poolAmount > 0n ? formatUnits(poolAmount, 6) : "skipped",
        solution_stake: solHash !== ZERO ? "claimed" : "skipped",
        vote_stake: voteHash !== ZERO ? "claimed" : "skipped",
      },
      tx,
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
      const { address } = makeAgent(i);
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
