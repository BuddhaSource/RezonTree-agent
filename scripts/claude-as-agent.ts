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
//   sponsor         — preflight + runSponsorFlow (sign Envelope(Sponsor) →
//                     POST /intents → sponsorSubmit)
//   cosponsor       — preflight + runCosponsorFlow (submit env)
//   commit          — preflight + runCommitFlow (submit env)
//   vote            — preflight + runVoteFlow (submit env, voteSalt-bound)
//   claim           — preflight(claim) + runClaimFlow (pullValue, Merkle proof
//                     from the persisted root-verified leaf set)
//   refund          — preflight(refund) + runRefundFlow (pullValue; --source
//                     <0x..> for a stake refund, omit for sponsor refund)
//   list-questions  — GET /v1/questions (read-only)
//   get-question    — GET /v1/questions/:id
//   list-solutions  — GET /v1/questions/:id?include=solutions
//
// All actions accept content as either CLI flags or stdin JSON.
//
// v1 → v2 rewrite (#629): the write actions moved from the removed v1
// intent builders + signUSDCPermit (EIP-2612 is gone) + the removed
// sponsor/cosponsor/commitSolution/castVote chain functions to the
// Quadphase v2 unified-envelope flows, mirroring the live MCP server.
// USDC escrow is now safeTransferFrom — pre-approve once via
// ensureUsdcAllowance instead of an inline permit signature.

import "dotenv/config";
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";

import { deriveAgentWallets } from "../src/wallet/derive.js";
import { getAgentBalance } from "../src/wallet/balance.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { parseAmountToWei } from "../src/intents/sponsor-intent.js";
import { canonicalStringify } from "../src/intents/commit-intent.js";
import type {
  CommitPreflight,
  FundPreflight,
  VotePreflight,
} from "../src/intents/preflight-types.js";
import { makeAgentWalletClient, awaitReceipt } from "../src/forge/quadphase-broadcast.js";
import {
  ensureUsdcAllowance,
  runClaimFlow,
  runCommitFlow,
  runCosponsorFlow,
  runRefundFlow,
  runSponsorFlow,
  runVoteFlow,
} from "../src/forge/quadphase-flow.js";

// MCP-allocation shape from stdin (conviction points, sum=100). Mapped to
// v2 bps (×100) + bytes32 solutionId below.
interface Allocation {
  solutionId: string;
  points: number;
}

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
  const r = await fetch(`${API_URL}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/v1/sessions failed: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { accessToken: string };
  tokens[idx] = { jwt: j.accessToken, exp: Date.now() + 14 * 60 * 1000 };
  return j.accessToken;
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
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = makeAgentWalletClient({
    privateKey: wallet.privateKey,
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
  });
  return {
    wallet,
    publicClient,
    walletClient,
    privateKey: wallet.privateKey as Hex,
    address: wallet.address as Address,
  };
}

// POST a unified preflight (v2 surface). `callerKey` is the query param
// the per-action backend handler reads (sponsor / submitter / voter).
async function preflight<T>(
  idx: number,
  qid: string,
  actionType: string,
  callerKey: string,
  caller: Address,
): Promise<T> {
  return (await api(
    idx,
    "POST",
    `/v1/questions/${qid}/intents/preflight?${callerKey}=${caller}`,
    { actionType, params: { [callerKey]: caller } },
  )) as T;
}

// Resolve the frozen fee-share policy from a preflight (#619). The chain
// reverts a commit/vote whose feeShares[] don't match the question's
// frozen policy; sponsor mode seeds it (100% → platform).
function feeShareFromPreflight(
  pre: { feeShareBps?: number | string; feeShares?: { recipient: string; basisPoints: number }[]; platformFeeRecipient?: string },
  fallbackRecipient: Address,
): { feeShareBps: number; feeShares: { recipient: Address; basisPoints: number }[] } {
  const platformFeeRecipient = (pre.platformFeeRecipient as Address | undefined) ?? fallbackRecipient;
  const feeShareBps = Number(pre.feeShareBps ?? 0);
  const feeShares =
    pre.feeShares && pre.feeShares.length > 0
      ? pre.feeShares.map((s) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
      : [{ recipient: platformFeeRecipient, basisPoints: 10000 }];
  return { feeShareBps, feeShares };
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
  const { publicClient, walletClient, privateKey, address } = clientsFor(idx);
  const bearer = await jwtFor(idx);
  // Probe preflight (no amount) to learn token decimals, then convert the
  // human amount → base units.
  const probe = await preflight<FundPreflight>(idx, qid, "sponsor", "sponsor", address);
  const amountWei = parseAmountToWei(amount, probe.token.decimals);
  // #656: re-run the preflight BOUND to the requested amount so the backend
  // bakes poolIn = amountWei into the template + expectedIntentHash. Without
  // the &amount= bind the template carries only the floor and any amount !=
  // floor drifts the intent hash (assertIntentHashMatch refuses to sign).
  const pre = (await api(
    idx,
    "POST",
    `/v1/questions/${qid}/intents/preflight?sponsor=${address}&amount=${amountWei.toString()}`,
    { actionType: "sponsor", params: { sponsor: address } },
  )) as FundPreflight;
  const nonce = BigInt(pre.nonce ?? "0");
  const expiresAt = BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300);
  const { feeShareBps } = feeShareFromPreflight(pre, address);
  const platformFeeRecipient = (pre.platformFeeRecipient as Address | undefined) ?? address;

  // BountyForge escrow uses safeTransferFrom — one MAX approve per wallet/forge.
  await ensureUsdcAllowance(walletClient, publicClient, {
    usdc: USDC, forge: FORGE!, owner: address, required: amountWei,
  });

  if (pre.mode === "sponsor") {
    // Sponsor binds per-Q params on-chain. The backend's preflight returns
    // the canonical envelope+witness it hashed into expectedIntentHash;
    // build the SponsorWitness from THAT template (not a re-derived
    // /v1/questions read) so the client contentHash reproduces the
    // backend's byte-for-byte. Re-deriving criteria/tags drifts the hash
    // (R-CLIENT-IS-TRUST-ORIGIN + R-INTENT-HASH-IS-MATCH-KEY). #629.
    const tmpl = (pre as unknown as {
      envelopeTemplate?: { witness?: Record<string, unknown> };
    }).envelopeTemplate;
    const wt = tmpl?.witness;
    if (!wt) throw new Error("sponsor preflight missing envelopeTemplate.witness — backend too old?");
    const result = await runSponsorFlow({
      baseUrl: API_URL, bearerToken: bearer, signer: address, questionId: qid,
      qid: pre.qid as Hex, nonce, expiresAt, forgeAddress: FORGE!,
      chainId: pre.chainId ?? CHAIN_ID,
      expectedIntentHash: pre.expectedIntentHash as Hex,
      title: String(wt.title ?? ""), body: String(wt.body ?? ""),
      criteria: String(wt.criteria ?? ""),
      tags: (wt.tags as string[] | null) ?? [],
      oracle: wt.oracle as Address,
      sponsorshipFloor: BigInt((wt.sponsorshipFloor as string | number) ?? 0),
      commitFee: BigInt((wt.commitFee as string | number) ?? 0),
      voteFee: BigInt((wt.voteFee as string | number) ?? 0),
      stakeFloor: BigInt((wt.stakeFloor as string | number) ?? 0),
      stakeBasisPoints: Number(wt.stakeBasisPoints ?? 0),
      fundingDeadline: BigInt((wt.fundingDeadline as string | number) ?? 0),
      noSolutionGracePeriod: BigInt((wt.noSolutionGracePeriod as string | number) ?? 0),
      token: pre.token.contractAddress as Address, amount: amountWei, feeAmount: 0n,
      feeShareBps: amountWei > 0n ? feeShareBps : 0,
      feeShares: amountWei > 0n ? [{ recipient: platformFeeRecipient, basisPoints: 10000 }] : [],
      walletClient, privateKey,
    });
    await awaitReceipt(publicClient, result.txHash!);
    console.log(JSON.stringify({ mode: "sponsor", txHash: result.txHash, intentHash: result.intentHash }, null, 2));
    return;
  }

  // cosponsor — a pure pool top-up. The cosponsor carries NO feeShares
  // of its own: the fee-share policy is frozen by the first sponsor, and
  // a cosponsor top-up only adds to the pool (#656 / contract gate
  // `shape:cosponsor:feeShares-must-be-empty`). The backend's cosponsor
  // preflight bakes the canonical envelope with empty feeShares +
  // feeShareBps=0 and computes `expectedIntentHash` over THAT; runCosponsorFlow
  // hardcodes the same empty array, so the locally-recomputed hash always
  // matches preflight (a stale non-empty array drifts the hash → HTTP 400).
  const result = await runCosponsorFlow({
    baseUrl: API_URL, bearerToken: bearer, signer: address, questionId: qid,
    qid: pre.qid as Hex, nonce, expiresAt, forgeAddress: FORGE!,
    chainId: pre.chainId ?? CHAIN_ID,
    expectedIntentHash: pre.expectedIntentHash as Hex,
    token: pre.token.contractAddress as Address, amount: amountWei, feeAmount: 0n,
    walletClient, privateKey,
  });
  await awaitReceipt(publicClient, result.txHash!);
  console.log(JSON.stringify({ mode: "cosponsor", txHash: result.txHash, intentHash: result.intentHash }, null, 2));
}

async function actCommit(idx: number, qid: string, body: {
  body: string;
  reasoningTree: Array<{ because: string; therefore: string }>;
  claims: Array<{ criterionId: string; value: unknown; argument: string; falsifiableBy: string }>;
}) {
  const { publicClient, walletClient, privateKey, address } = clientsFor(idx);
  const bearer = await jwtFor(idx);
  const pre = await preflight<CommitPreflight>(idx, qid, "commit", "submitter", address);
  const feeAmount = BigInt(pre.feeAmount);
  const stakeAmount = BigInt(pre.stakeAmount);
  const { feeShareBps, feeShares } = feeShareFromPreflight(pre, address);

  await ensureUsdcAllowance(walletClient, publicClient, {
    usdc: USDC, forge: FORGE!, owner: address, required: feeAmount + stakeAmount,
  });

  // CommitWitness.solutionBody = canonical JSON of the structured body.
  const solutionBody = canonicalStringify({
    body: body.body, reasoningTree: body.reasoningTree, claims: body.claims,
  });

  const result = await runCommitFlow({
    baseUrl: API_URL, bearerToken: bearer, signer: address, questionId: qid,
    qid: pre.qid as Hex, nonce: BigInt(pre.nonce ?? "0"),
    expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
    forgeAddress: FORGE!, chainId: pre.chainId ?? CHAIN_ID,
    solutionBody, references: [],
    token: pre.token.contractAddress as Address, feeAmount, stakeAmount,
    feeShareBps, feeShares,
    walletClient, privateKey,
  });
  await awaitReceipt(publicClient, result.txHash!);
  console.log(JSON.stringify({
    txHash: result.txHash, intentHash: result.intentHash,
    feeAmount: feeAmount.toString(), stakeAmount: stakeAmount.toString(),
  }, null, 2));
}

async function actVote(idx: number, qid: string, allocations: Allocation[]) {
  const { publicClient, walletClient, privateKey, address } = clientsFor(idx);
  const bearer = await jwtFor(idx);
  const pre = await preflight<VotePreflight>(idx, qid, "vote", "voter", address);
  if (!pre.voteSalt || !pre.voteSaltToken) {
    throw new Error("vote preflight missing voteSalt/voteSaltToken (passed ?voter=?)");
  }

  // Resolve sol_xxx API ids → bytes32 intentHashes; map points → bps.
  const detail = (await api(idx, "GET", `/v1/questions/${qid}?include=solutions`)) as {
    solutions?: { data?: Array<{ id: string; intentHash: string }> };
  };
  const hashBySol = new Map<string, Hex>(
    (detail.solutions?.data ?? []).map((s) => [s.id, s.intentHash as Hex]),
  );
  let bpsSum = 0;
  const v2Allocations = allocations.map((a) => {
    const intentHash = hashBySol.get(a.solutionId);
    if (!intentHash) throw new Error(`solution ${a.solutionId} not found / not confirmed on ${qid}`);
    const basisPoints = a.points * 100;
    bpsSum += basisPoints;
    return { solutionId: intentHash, basisPoints };
  });
  if (bpsSum !== 10000) throw new Error(`allocation points must sum to 100 (got ${bpsSum / 100})`);

  const feeAmount = BigInt(pre.feeAmount);
  const stakeAmount = BigInt(pre.stakeAmount);
  const { feeShareBps, feeShares } = feeShareFromPreflight(pre, address);

  await ensureUsdcAllowance(walletClient, publicClient, {
    usdc: USDC, forge: FORGE!, owner: address, required: feeAmount + stakeAmount,
  });

  const result = await runVoteFlow({
    baseUrl: API_URL, bearerToken: bearer, signer: address, questionId: qid,
    qid: pre.qid as Hex, nonce: BigInt(pre.nonce ?? "0"),
    // expiresAt MUST equal voteSaltExpiresAt — the HMAC binds it.
    expiresAt: BigInt(pre.voteSaltExpiresAt!),
    forgeAddress: FORGE!, chainId: pre.chainId ?? CHAIN_ID,
    // Vote intent hash is allocation-dependent; the preflight returns an
    // empty-allocations placeholder (VotePreflight H-8), so we don't assert
    // against it — runVoteFlow sends the real recomputed hash and the
    // backend re-derives at Stage 2. #629.
    expectedIntentHash: undefined,
    allocations: v2Allocations,
    voteSalt: pre.voteSalt as Hex, voteSaltToken: pre.voteSaltToken as Hex,
    token: pre.token.contractAddress as Address, feeAmount, stakeAmount,
    feeShareBps, feeShares,
    walletClient, privateKey,
  });
  await awaitReceipt(publicClient, result.txHash!);
  console.log(JSON.stringify({ txHash: result.txHash, intentHash: result.intentHash }, null, 2));
}

// Round-3 ClaimDraft / RefundDraft (actionType=claim|refund on the
// unified /intents/preflight). Both carry the v2 envelope template.
interface ClaimDraft {
  qid: Hex; recipient: string; leafIndex: string; leafAmount: string;
  role: number; proof: Hex[]; chainId?: number; nonce?: string;
  recommendedExpiresAt?: number; expectedIntentHash?: string;
  envelopeTemplate?: { envelope?: { funds?: { token?: string } } };
}
interface RefundDraft {
  qid: Hex; signer: string; sourceIntentHash: string; expectedAmount: string;
  expectedStatus: number; chainId?: number; nonce?: string;
  recommendedExpiresAt?: number; expectedIntentHash?: string;
  envelopeTemplate?: { envelope?: { funds?: { token?: string } } };
}

// Funds token lives inside the signed envelope template; the claim/refund
// flow MUST rebuild funds with the SAME token or the contentHash drifts
// from the backend's expectedIntentHash. Falls back to USDC (the only
// bounty token in use today).
function tokenFromDraft(d: { envelopeTemplate?: { envelope?: { funds?: { token?: string } } } }): Address {
  return (d.envelopeTemplate?.envelope?.funds?.token as Address | undefined) ?? USDC;
}

// claim — winner/voter pull of a settled-question Merkle leaf. Preflight
// returns the proof + leafIndex/leafAmount/role from the persisted,
// root-verified leaf set (backend single-source, leafset I3b-3); the SDK
// signs Envelope(Claim) + ClaimWitness and broadcasts pullValue().
async function actClaim(idx: number, qid: string, dry = false) {
  const { publicClient, walletClient, privateKey, address } = clientsFor(idx);
  const bearer = await jwtFor(idx);
  const pre = await preflight<ClaimDraft>(idx, qid, "claim", "recipient", address);
  if (dry) {
    // Preflight-only: inspect the witness the backend serves (proof from
    // the persisted root-verified leaf set) without broadcasting.
    console.log(JSON.stringify({
      action: "claim-dry", recipient: address, leafAmount: pre.leafAmount,
      leafIndex: pre.leafIndex, role: pre.role, proofLen: pre.proof?.length ?? 0,
      proof: pre.proof, expectedIntentHash: pre.expectedIntentHash,
    }, null, 2));
    return;
  }
  const result = await runClaimFlow({
    baseUrl: API_URL, bearerToken: bearer, signer: address, questionId: qid,
    qid: pre.qid, nonce: BigInt(pre.nonce ?? "0"),
    expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
    forgeAddress: FORGE!, chainId: pre.chainId ?? CHAIN_ID,
    token: tokenFromDraft(pre),
    proof: pre.proof, leafIndex: BigInt(pre.leafIndex), leafAmount: BigInt(pre.leafAmount),
    role: pre.role, expectedStatus: 3 /* Settled */,
    expectedIntentHash: (pre.expectedIntentHash as Hex | undefined) || undefined,
    walletClient, privateKey,
  });
  await awaitReceipt(publicClient, result.txHash!);
  console.log(JSON.stringify({
    action: "claim", txHash: result.txHash, intentHash: result.intentHash,
    leafAmount: pre.leafAmount, role: pre.role,
  }, null, 2));
}

// refund — stake or sponsor pull. --source <0x..> selects the staked
// commit/vote intentHash; omit it for a sponsor refund (sentinel 0x00…00,
// status=Abandoned). expectedAmount comes from the preflight (the #9-refund
// fix sources voter stake from votes.stake_amount).
async function actRefund(idx: number, qid: string, source?: string, dry = false) {
  const { publicClient, walletClient, privateKey, address } = clientsFor(idx);
  const bearer = await jwtFor(idx);
  const sourceQuery = source ? `&source_intent_hash=${source}` : "";
  const pre = (await api(
    idx, "POST",
    `/v1/questions/${qid}/intents/preflight?signer=${address}${sourceQuery}`,
    { actionType: "refund", params: { signer: address, source_intent_hash: source ?? "" } },
  )) as RefundDraft;
  if (dry) {
    console.log(JSON.stringify({
      action: "refund-dry", signer: address, expectedAmount: pre.expectedAmount,
      sourceIntentHash: pre.sourceIntentHash, expectedStatus: pre.expectedStatus,
      source: source ?? "sponsor", expectedIntentHash: pre.expectedIntentHash,
    }, null, 2));
    return;
  }
  const result = await runRefundFlow({
    baseUrl: API_URL, bearerToken: bearer, signer: address, questionId: qid,
    qid: pre.qid, nonce: BigInt(pre.nonce ?? "0"),
    expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
    forgeAddress: FORGE!, chainId: pre.chainId ?? CHAIN_ID,
    token: tokenFromDraft(pre),
    sourceIntentHash: (pre.sourceIntentHash as Hex) ??
      ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex),
    expectedAmount: BigInt(pre.expectedAmount), expectedStatus: pre.expectedStatus,
    expectedIntentHash: (pre.expectedIntentHash as Hex | undefined) || undefined,
    walletClient, privateKey,
  });
  await awaitReceipt(publicClient, result.txHash!);
  console.log(JSON.stringify({
    action: "refund", txHash: result.txHash, intentHash: result.intentHash,
    expectedAmount: pre.expectedAmount, source: source ?? "sponsor",
  }, null, 2));
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
  // Round-3: solutions fold into question detail via ?include=solutions
  // (the standalone /solutions route was removed in the 14-endpoint cut).
  const r = await fetch(`${API_URL}/v1/questions/${qid}?include=solutions`);
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
    case "claim":           await actClaim(idx, argv.flags.qid, argv.flags.dry === "true"); break;
    case "refund":          await actRefund(idx, argv.flags.qid, argv.flags.source, argv.flags.dry === "true"); break;
    case "list-questions":  await actList(idx); break;
    case "get-question":    await actGet(idx, argv.flags.qid); break;
    case "list-solutions":  await actListSolutions(idx, argv.flags.qid); break;
    default:
      console.error(`unknown action: ${action}`); process.exit(2);
  }
})().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
