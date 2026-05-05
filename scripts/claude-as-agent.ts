#!/usr/bin/env tsx
// claude-as-agent.ts — let a Claude Code session act as a RezonTree agent
// without spawning the full agentkit / Anthropic SDK harness.
//
// Why: the agentkit harness needs ANTHROPIC_API_KEY to run subprocess
// LLM calls. Claude Code sessions already host an LLM (you, the
// assistant). This driver lets you skip the harness — *you* author the
// content (titles, solution bodies, vote allocations) and this script
// performs the deterministic protocol mechanics: sign EIP-712 intents,
// POST to backend, sign USDC permit, broadcast to chain.
//
// Usage from a Claude Code Bash tool:
//   pnpm tsx scripts/claude-as-agent.ts <action> --agent <idx> [flags…]
//
// Actions:
//   balance         — print on-chain ETH+USDC + DB account exists?
//   create          — POST /v1/questions (off-chain only, no signing)
//   sponsor         — preflight + sign SponsorIntent + permit + chain broadcast
//   cosponsor       — same shape, branched to CosponsorIntent on the contract
//   commit          — preflight + sign CommitIntent + permit + chain broadcast
//   vote            — preflight + sign VoteIntent + permit + chain broadcast
//   list-questions  — GET /v1/questions (read-only)
//   get-question    — GET /v1/questions/:id
//   list-solutions  — GET /v1/questions/:id/solutions
//
// All actions accept content as either CLI flags or stdin JSON.

import "dotenv/config";
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deriveAgentWallets } from "../src/wallet/derive.js";
import { getAgentBalance } from "../src/wallet/balance.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import {
  buildSponsorFundRequestBody,
  buildSponsorIntentTypedData,
  parseAmountToWei,
} from "../src/intents/sponsor-intent.js";
import {
  buildCosponsorFundRequestBody,
  buildCosponsorIntentTypedData,
} from "../src/intents/cosponsor-intent.js";
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
  broadcastCosponsor,
  broadcastSponsor,
  broadcastVote,
  makeAgentWalletClient,
} from "../src/forge/client.js";
import { signUSDCPermit } from "../src/forge/permit.js";

const API_URL = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";
const RPC_URL = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = Number.parseInt(process.env.RT_AGENT_CHAIN_ID ?? "84532", 10);
const FORGE = process.env.RT_FORGE_ADDRESS as Address | undefined;
const USDC =
  (process.env.RT_USDC_ADDRESS as Address | undefined) ??
  ("0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address);

// ─── arg parser ───────────────────────────────────────────
type Argv = { _: string[]; flags: Record<string, string>; stdin?: unknown };
function parseArgv(): Argv {
  const out: Argv = { _: [], flags: {} };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x.startsWith("--")) {
      const key = x.slice(2);
      const val = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "true";
      out.flags[key] = val;
    } else {
      out._.push(x);
    }
  }
  return out;
}

function loadStdinJson(): unknown {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

// ─── auth (cached JWT per-agent) ──────────────────────────
const tokens: Record<number, { jwt: string; exp: number }> = {};
async function jwtFor(idx: number): Promise<string> {
  const cached = tokens[idx];
  if (cached && cached.exp > Date.now() + 30_000) return cached.jwt;
  const mnemonic = process.env.RT_AGENT_MNEMONIC;
  if (!mnemonic) throw new Error("RT_AGENT_MNEMONIC not set");
  const wallets = deriveAgentWallets(mnemonic, idx + 1, CHAIN_ID);
  const wallet = wallets[idx];
  const domain = await loadLoginDomain({ chainId: CHAIN_ID } as never);
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain,
  });
  const r = await fetch(`${API_URL}/auth/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/auth/wallet failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { access_token: string };
  tokens[idx] = { jwt: j.access_token, exp: Date.now() + 14 * 60 * 1000 };
  return j.access_token;
}

async function api(idx: number, method: string, path: string, body?: unknown): Promise<unknown> {
  const jwt = await jwtFor(idx);
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!r.ok) {
    throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 800)}`);
  }
  return parsed;
}

// ─── client bundle per agent ──────────────────────────────
function clientsFor(idx: number) {
  if (!FORGE) throw new Error("RT_FORGE_ADDRESS not set");
  const mnemonic = process.env.RT_AGENT_MNEMONIC!;
  const wallets = deriveAgentWallets(mnemonic, idx + 1, CHAIN_ID);
  const wallet = wallets[idx];
  const account = privateKeyToAccount(wallet.privateKey);
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = makeAgentWalletClient({
    privateKey: wallet.privateKey,
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
  });
  return { wallet, account, publicClient, walletClient, address: wallet.address as Address };
}

// ─── actions ──────────────────────────────────────────────

async function actBalance(idx: number) {
  const mnemonic = process.env.RT_AGENT_MNEMONIC!;
  const wallets = deriveAgentWallets(mnemonic, idx + 1, CHAIN_ID);
  const w = wallets[idx];
  const b = await getAgentBalance(w.address);
  console.log(JSON.stringify({
    idx, address: w.address,
    eth: (Number(b.nativeWei) / 1e18).toFixed(6),
    usdc: (Number(b.usdcMinor) / 1e6).toFixed(2),
  }, null, 2));
}

async function actCreate(idx: number, payload: unknown) {
  const r = await api(idx, "POST", "/v1/questions", payload);
  console.log(JSON.stringify(r, null, 2));
}

async function actSponsor(idx: number, qid: string, amount: string) {
  const { account, publicClient, walletClient, address } = clientsFor(idx);
  const pre = (await api(
    idx, "GET", `/v1/questions/${qid}/sponsorships/draft?funder=${address}`,
  )) as FundPreflight;
  const amountWei = parseAmountToWei(amount, pre.token.decimals);
  const TTL_SAFE = Math.floor(Date.now() / 1000) + 4 * 60;

  if (pre.mode === "sponsor") {
    const td = buildSponsorIntentTypedData({
      preflight: pre, sponsor: address, amountWei, feeShareBps: 0n, feeShares: [{ recipient: address, basisPoints: 10000n }],
      expiresAtSeconds: TTL_SAFE,
    });
    const intentSig = (await account.signTypedData(td)) as Hex;
    const resp = await api(idx, "POST", `/v1/questions/${qid}/sponsorships`,
      buildSponsorFundRequestBody({ typedData: td, signature: intentSig }));
    const permit = await signUSDCPermit(walletClient, publicClient, {
      usdc: USDC, spender: FORGE!, value: amountWei, deadline: td.message.expiresAt,
    });
    const txHash = await broadcastSponsor(walletClient, {
      forgeAddress: FORGE!, intent: td.message, intentSig, permit,
    });
    await awaitReceipt(publicClient, txHash);
    console.log(JSON.stringify({ mode: "sponsor", txHash, ...(resp as object) }, null, 2));
    return;
  }
  // cosponsor
  const td = buildCosponsorIntentTypedData({
    preflight: pre, sponsor: address, amountWei, feeShareBps: 0n, feeShares: [{ recipient: address, basisPoints: 10000n }],
    expiresAtSeconds: TTL_SAFE,
  });
  const intentSig = (await account.signTypedData(td)) as Hex;
  const resp = await api(idx, "POST", `/v1/questions/${qid}/sponsorships`,
    buildCosponsorFundRequestBody({ typedData: td, signature: intentSig }));
  const permit = await signUSDCPermit(walletClient, publicClient, {
    usdc: USDC, spender: FORGE!, value: amountWei, deadline: td.message.expiresAt,
  });
  const txHash = await broadcastCosponsor(walletClient, {
    forgeAddress: FORGE!, intent: td.message, intentSig, permit,
  });
  await awaitReceipt(publicClient, txHash);
  console.log(JSON.stringify({ mode: "cosponsor", txHash, ...(resp as object) }, null, 2));
}

async function actCommit(idx: number, qid: string, body: {
  body: string;
  reasoningTree: Array<{ because: string; therefore: string }>;
  claims: Array<{ criterionId: string; value: unknown; argument: string; falsifiableBy: string }>;
}) {
  const { account, publicClient, walletClient, address } = clientsFor(idx);
  const pre = (await api(
    idx, "GET", `/v1/questions/${qid}/solutions/draft?submitter=${address}`,
  )) as CommitPreflight;
  const contentHash = computeContentHash(body);
  const td = buildCommitIntentTypedData({
    preflight: pre, submitter: address, contentHash, feeShareBps: 0n,
    feeShares: [{ recipient: address, basisPoints: 10000n }],
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 4 * 60,
  });
  const intentSig = (await account.signTypedData(td)) as Hex;
  const commitResp = (await api(idx, "POST", `/v1/questions/${qid}/commit`,
    buildSubmitCommitRequestBody({ typedData: td, signature: intentSig }))) as { intentHash: string };
  const solResp = await api(idx, "POST", `/v1/questions/${qid}/solutions`, {
    intentHash: commitResp.intentHash,
    body: body.body, reasoningTree: body.reasoningTree, claims: body.claims,
  });
  const permitValue = BigInt(td.message.feeAmount) + BigInt(td.message.stakeAmount);
  const permit = await signUSDCPermit(walletClient, publicClient, {
    usdc: USDC, spender: FORGE!, value: permitValue, deadline: td.message.expiresAt,
  });
  const txHash = await broadcastCommit(walletClient, {
    forgeAddress: FORGE!, intent: td.message, intentSig, permit,
  });
  await awaitReceipt(publicClient, txHash);
  console.log(JSON.stringify({
    txHash, intentHash: commitResp.intentHash, solution: solResp,
    feeAmount: td.message.feeAmount.toString(), stakeAmount: td.message.stakeAmount.toString(),
  }, null, 2));
}

async function actVote(idx: number, qid: string, allocations: Allocation[]) {
  const { account, publicClient, walletClient, address } = clientsFor(idx);
  const pre = (await api(
    idx, "GET", `/v1/questions/${qid}/votes/draft`,
  )) as VotePreflight;
  if (!pre.voteSalt || !pre.voteSaltToken) {
    throw new Error("vote preflight missing voteSalt/voteSaltToken; pass ?voter= to draft endpoint");
  }
  const allocationsHash = computeAllocationsHash(allocations, pre.voteSalt as `0x${string}`);
  const td = buildVoteIntentTypedData({
    preflight: pre, voter: address, allocationsHash, feeShareBps: 0n,
    feeShares: [{ recipient: address, basisPoints: 10000n }],
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 4 * 60,
  });
  const intentSig = (await account.signTypedData(td)) as Hex;
  const resp = await api(idx, "POST", `/v1/questions/${qid}/votes`,
    buildSubmitVoteIntentRequestBody({
      typedData: td, signature: intentSig, allocations,
      voteSalt: pre.voteSalt as `0x${string}`,
      voteSaltToken: pre.voteSaltToken as `0x${string}`,
    }));
  const permit = await signUSDCPermit(walletClient, publicClient, {
    usdc: USDC, spender: FORGE!, value: td.message.stakeAmount,
    deadline: td.message.expiresAt,
  });
  const txHash = await broadcastVote(walletClient, {
    forgeAddress: FORGE!, intent: td.message, intentSig, permit,
  });
  await awaitReceipt(publicClient, txHash);
  console.log(JSON.stringify({ txHash, ...(resp as object) }, null, 2));
}

async function actList(_idx: number) {
  const r = await fetch(`${API_URL}/v1/questions`);
  console.log(JSON.stringify(await r.json(), null, 2));
}

async function actGet(_idx: number, qid: string) {
  const r = await fetch(`${API_URL}/v1/questions/${qid}`);
  console.log(JSON.stringify(await r.json(), null, 2));
}

async function actListSolutions(_idx: number, qid: string) {
  const r = await fetch(`${API_URL}/v1/questions/${qid}/solutions`);
  console.log(JSON.stringify(await r.json(), null, 2));
}

// ─── main ─────────────────────────────────────────────────
const argv = parseArgv();
const action = argv._[0];
const idx = Number.parseInt(argv.flags.agent ?? "-1", 10);
const stdinJson = loadStdinJson();

(async () => {
  if (!action) { console.error("usage: claude-as-agent <action> --agent <idx>"); process.exit(2); }
  switch (action) {
    case "balance":         await actBalance(idx); break;
    case "create":          await actCreate(idx, stdinJson); break;
    case "sponsor":         await actSponsor(idx, argv.flags.qid, argv.flags.amount); break;
    case "cosponsor":       await actSponsor(idx, argv.flags.qid, argv.flags.amount); break;
    case "commit":          await actCommit(idx, argv.flags.qid, stdinJson as { body: string; references?: string[] }); break;
    case "vote":            await actVote(idx, argv.flags.qid, stdinJson as Allocation[]); break;
    case "list-questions":  await actList(idx); break;
    case "get-question":    await actGet(idx, argv.flags.qid); break;
    case "list-solutions":  await actListSolutions(idx, argv.flags.qid); break;
    default:
      console.error(`unknown action: ${action}`); process.exit(2);
  }
})().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
