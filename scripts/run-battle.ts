#!/usr/bin/env tsx
// run-battle.ts — Phase D end-to-end battle harness.
//
// Reads scripts/battle-scenarios.yaml, walks each scenario through
// the full RezonForge lifecycle:
//
//   sponsor  →  cosponsor*  →  commit*  →  vote*
//             →  settle  →  claim*  →  stake-refund*
//
// Then asserts:
//   • happy-path scenarios settle to the intended winner
//   • sybil scenarios produce defense_holds (honest-voter conviction
//     dominates) and the audit flags the linkage
//   • attack scenarios are rejected at the named layer (intake or
//     chain) — the runner uses the SAME signed-intent path the
//     happy paths use, but deliberately violates one constraint.
//
// Output: writes scripts/battle-report.json with per-scenario
// outcome + finance reconciliation.
//
// R-CHAIN-VERIFIES-INTENT — the chain remains the source of truth
//   for every outcome assertion; backend rows are correlated, not
//   trusted blindly.
// R-CLIENT-IS-TRUST-ORIGIN — every intent is built from the
//   advertised preflight; attacks deliberately violate this.
// R-MALICIOUS-FLOW — attack catalogue is tracked end-to-end so
//   the report shows defense_layer for each.

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type Address,
  type Hex,
  createPublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import type { AgentWallet } from "../src/wallet/types.js";
import {
  fetchWithRetry,
  makeFallbackTransport,
  resolveRpcUrls,
} from "../src/testnet/rpc-fallback.js";
import { makeSolutionBody } from "../src/testnet/solution-body.js";

import { parseAmountToWei } from "../src/intents/sponsor-intent.js";
import { canonicalStringify } from "../src/intents/commit-intent.js";
import type {
  CommitPreflight,
  FundPreflight,
  VotePreflight,
} from "../src/intents/preflight-types.js";

import {
  ActionTag,
  StakeOp,
  type Envelope,
  type Funds,
  buildEnvelopeForSigning,
  hashEnvelopeStruct,
} from "../src/intents/envelope.js";
import { buildSponsorWitness } from "../src/intents/sponsor-witness.js";
import { buildCommitWitness } from "../src/intents/commit-witness.js";
import {
  awaitReceipt,
  broadcastClaim,
  broadcastSponsorSubmit,
  broadcastSubmit,
  makeAgentWalletClient,
} from "../src/forge/quadphase-broadcast.js";
import {
  ensureUsdcAllowance,
  runCommitFlow,
  runCosponsorFlow,
  runSponsorFlow,
  runVoteFlow,
  serializeEnvelope,
  serializeSponsorWitness,
  stringifyWithBigInts,
} from "../src/forge/quadphase-flow.js";

import {
  type AttackResult,
  type BattleAudit,
  type FinanceSnapshot,
  type NamedActor,
  type PerQuestionAudit,
  type QuestionOutcome,
  type QuestionTrace,
  FORGE_READ_ABI,
  fmtUsdc6,
  readAccruedFees,
  reconcileQuestion,
  renderActorDeltaCsv,
  snapshotFinance,
} from "./finance-audit.js";
import {
  sweepWalletQuestion,
  type SweepOptions,
} from "./lib/operator-recovery.js";

// Vote allocation in MCP shape (conviction points, sum=100). Mapped to
// v2 basis points (×100) + bytes32 solutionId at submit time.
interface Allocation {
  solutionId: string;
  points: number;
}

// ── Env ──────────────────────────────────────────────────────────

const BACKEND = process.env.RT_BACKEND_URL ?? "http://localhost:8080";
// RPC failover. Prefer RT_AGENT_RPC_URLS (comma-list) but accept legacy
// RT_RPC_URL or fall back to the curated public Base Sepolia trio.
// Loop 0136 50-question battle had a single endpoint return 502 mid-tx;
// the fallback transport rotates through the list with retry+backoff.
const RPC_URLS = resolveRpcUrls(process.env);
const RPC = RPC_URLS[0]; // primary — used by makeAgentWalletClient where
//                                viem's writeContract is called directly.
const CHAIN_ID = Number.parseInt(process.env.RT_CHAIN_ID ?? "84532", 10);
const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FORGE = process.env.RT_FORGE_ADDRESS as Address | undefined;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
// Note: in v2 the backend oracle keeper computes the payout split +
// platform fee at settlement; the harness no longer applies a
// client-side fee bps (RT_PLATFORM_FEE_BPS retired).

if (!FORGE) throw new Error("RT_FORGE_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const log = (label: string, msg = "") =>
  console.log(`${c.cyan(`[${label}]`)} ${msg}`);
const ok = (msg: string) => console.log(`  ${c.green("✓")} ${msg}`);
const warn = (msg: string) => console.log(`  ${c.yellow("!")} ${msg}`);
const fail = (msg: string) => console.log(`  ${c.red("✗")} ${msg}`);
const info = (msg: string) => console.log(`  ${c.dim(msg)}`);

// ── Scenario types ──────────────────────────────────────────────

interface WalletPoolEntry { index: number; role: string }
interface SuccessCriterion {
  name: string;
  type: "boolean" | "number" | "string";
  target: string;
  weight: number;
}
interface Scenario {
  id: string;
  domain: string;
  title: string;
  description?: string;
  success_criteria: SuccessCriterion[];
  sponsor: string;
  cosponsors?: string[];
  solvers: string[];
  voters: string[];
  intended_winner_profile: string;
  expected_outcome: "success" | "expected_failure" | "defense_holds";
}
interface SybilScenario extends Scenario {
  sybil_links: string[][];
  expected_sybil_findings?: string[];
}
interface AttackScenario {
  id: string;
  title: string;
  description?: string;
  attack: string;
  expected_defense_layer: string;
  expected_http_status?: number;
  expected_error_code?: string;
  expected_outcome: "expected_failure";
}
interface BattleConfig {
  version: number;
  wallet_pool: Record<string, WalletPoolEntry>;
  scenarios: Scenario[];
  sybil_scenarios: SybilScenario[];
  attack_scenarios: AttackScenario[];
}

// ── Wallet pool ──────────────────────────────────────────────────

interface AuthedWallet { wallet: AgentWallet; token: string; address: Address }

// JWT cache. Reuses logins across scenarios so back-to-back calls
// don't collide on WalletLoginIntent intent_hash (F-NEW-2). The access
// token issued by /v1/sessions is good for 15 min; we refresh at 13 min
// to leave headroom for slow lifecycles (F-NEW-3).
const JWT_LIFETIME_MS = 13 * 60 * 1000;
type CachedAuth = AuthedWallet & { issuedAt: number };
const _authCache = new Map<Address, CachedAuth>();

async function loginWallet(wallet: AgentWallet): Promise<AuthedWallet> {
  const cached = _authCache.get(wallet.address);
  if (cached && Date.now() - cached.issuedAt < JWT_LIFETIME_MS) {
    return cached;
  }
  // v2: /auth/wallet → /v1/sessions (WalletLoginIntent envelope). The
  // backend recovers the signer + auto-registers unknown wallets.
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain: loadLoginDomain(),
  });
  const r = await call<{ accessToken: string }>(
    "POST",
    "/v1/sessions",
    body,
  );
  const authed: CachedAuth = {
    wallet,
    token: r.accessToken,
    address: wallet.address as Address,
    issuedAt: Date.now(),
  };
  _authCache.set(wallet.address, authed);
  return authed;
}

// Unified v2 preflight POST. callerKey is the per-action query param the
// backend handler reads (sponsor / submitter / voter).
async function preflightV2<T>(
  questionId: string,
  actionType: string,
  callerKey: string,
  caller: Address,
  token: string,
): Promise<T> {
  return await call<T>(
    "POST",
    `/v1/questions/${questionId}/intents/preflight?${callerKey}=${caller}`,
    { actionType, params: { [callerKey]: caller } },
    token,
  );
}

// Frozen fee-share policy from a preflight (#619). Falls back to a
// 100%→fallbackRecipient policy when preflight omits it (pre-sponsor).
function feeShareFromPreflight(
  pre: { feeShareBps?: number | string; feeShares?: { recipient: string; basisPoints: number }[]; platformFeeRecipient?: string },
  fallbackRecipient: Address,
): { feeShareBps: number; feeShares: { recipient: Address; basisPoints: number }[]; platformFeeRecipient: Address } {
  const platformFeeRecipient = (pre.platformFeeRecipient as Address | undefined) ?? fallbackRecipient;
  const feeShareBps = Number(pre.feeShareBps ?? 0);
  const feeShares =
    pre.feeShares && pre.feeShares.length > 0
      ? pre.feeShares.map((s) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
      : [{ recipient: platformFeeRecipient, basisPoints: 10000 }];
  return { feeShareBps, feeShares, platformFeeRecipient };
}

// ── HTTP ─────────────────────────────────────────────────────────

interface ApiError { code: string; message?: string; action?: string }
class HttpError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: unknown,
  ) {
    const code = (body as { error?: ApiError })?.error?.code ?? "?";
    const action = (body as { error?: ApiError })?.error?.action ?? "";
    const message = (body as { error?: ApiError })?.error?.message ?? "";
    super(`${method} ${path} → ${status} (${code}) ${message} | ${action}`);
  }
  errorCode(): string | undefined {
    return (this.body as { error?: ApiError })?.error?.code;
  }
}

async function call<T = unknown>(
  method: string,
  pathStr: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  // fetchWithRetry retries 502/503/504 + network errors with backoff
  // (300/800/2000ms). 4xx falls through immediately so validation
  // failures don't loop. Mirrors the RPC fallback strategy above.
  const res = await fetchWithRetry(
    `${BACKEND}${pathStr}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    {
      onRetry: (attempt, info) => {
        warn(`retry #${attempt} ${method} ${pathStr} — ${info.reason} (sleep ${info.delayMs}ms)`);
      },
    },
  );
  const raw = await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
  if (!res.ok) throw new HttpError(method, pathStr, res.status, parsed);
  return parsed as T;
}

// Synthetic solution body lives in src/testnet/solution-body.ts so
// it's typechecked + unit-tested. SA-009 floor (1100 chars) is
// asserted there.

// ── Finance helpers ──────────────────────────────────────────────

// publicClient uses viem's fallback transport so reads (eth_call,
// getReceipt, etc) survive a single-endpoint outage. See
// src/testnet/rpc-fallback.ts.
const publicClient = createPublicClient({
  transport: makeFallbackTransport(RPC_URLS),
});

interface RoundContext {
  scenarioId: string;
  qid: Hex;
  trace: QuestionTrace;
  commitIntentHashes: Hex[];
  voteIntentHashes: Hex[];
  solversByLetter: Record<string, AuthedWallet>;
  votersByLetter: Record<string, AuthedWallet>;
  solutionsByLetter: Record<string, { id: string; intentHash: Hex; stake: bigint }>;
  votesByLetter: Record<string, { intentHash: Hex; stake: bigint; allocations: Allocation[] }>;
  feeWallet: AgentWallet;
  oracle: AgentWallet;
}

// ── Scenario walker ──────────────────────────────────────────────

class BattleRunner {
  private wallets: Record<string, AgentWallet> = {};
  private actors: NamedActor[] = [];
  private auditedScenarios: PerQuestionAudit[] = [];
  private attackResults: AttackResult[] = [];
  private sybilFindings: string[] = [];
  private startSnapshot: FinanceSnapshot | null = null;
  private knownQids: Hex[] = [];
  private knownCommits: Hex[] = [];
  private knownVotes: Hex[] = [];
  private results: { scenarioId: string; outcome: string; notes: string[] }[] = [];
  // How long to await the backend oracle keeper before recording a
  // scenario's lifecycle without the payout sweep. Default 180s.
  private settleWaitMs = Number.parseInt(process.env.RT_SETTLE_WAIT_SECONDS ?? "180", 10) * 1000;
  // address(lowercase) → {agentWallet, index} for the withdraw-door sweep.
  private bankByAddress = new Map<string, { agentWallet: AgentWallet; index: number }>();

  constructor(private cfg: BattleConfig) {
    for (const [letter, entry] of Object.entries(cfg.wallet_pool)) {
      this.wallets[letter] = deriveAgentWallet(MNEMONIC!, entry.index, CHAIN_ID);
      this.bankByAddress.set(this.wallets[letter].address.toLowerCase(), {
        agentWallet: this.wallets[letter],
        index: entry.index,
      });
      this.actors.push({
        name: letter,
        address: this.wallets[letter].address,
        role: entry.role,
      });
    }
  }

  /** Look up a pool wallet by its lowercase address — used by the
   *  withdraw-door money-out sweep to find the signing key for a
   *  participant the door reports as owed funds. */
  private walletByAddress(addrLower: string): { agentWallet: AgentWallet; index: number } | undefined {
    return this.bankByAddress.get(addrLower);
  }

  async snap(): Promise<FinanceSnapshot> {
    return snapshotFinance({
      publicClient,
      usdc: USDC,
      forge: FORGE!,
      wallets: this.actors.map((a) => a.address),
      qids: this.knownQids,
    });
  }

  async run(): Promise<BattleAudit> {
    const startedAt = new Date().toISOString();
    log("battle", c.bold(`backend ${BACKEND} | forge ${FORGE}`));
    info(`wallets: ${this.actors.map((a) => `${a.name}(${a.address.slice(0, 6)})`).join(", ")}`);

    this.startSnapshot = await this.snap();
    info(`opening chain total ${fmtUsdc6(this.startSnapshot.totalUsdc)} USDC`);

    // Happy-path + sybil scenarios share the lifecycle. SCENARIO_FILTER
    // env (comma list of ids) optionally narrows the run — useful for
    // 3-wallet smoke before the full pool is funded.
    const filter = (process.env.SCENARIO_FILTER ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const filterFn = (s: Scenario | SybilScenario) =>
      filter.length === 0 || filter.includes(s.id);
    const lifecycleScenarios = [
      ...this.cfg.scenarios,
      ...this.cfg.sybil_scenarios,
    ].filter(filterFn);
    // F-NEW-6: rebalance alice from bob/operator every N scenarios so
    // a long battle doesn't drain mid-run. Default N=10; opt out with
    // RT_REBALANCE_EVERY=0.
    const rebalanceEvery = Number.parseInt(
      process.env.RT_REBALANCE_EVERY ?? "10",
      10,
    );
    for (let i = 0; i < lifecycleScenarios.length; i++) {
      const s = lifecycleScenarios[i];
      if (rebalanceEvery > 0 && i > 0 && i % rebalanceEvery === 0) {
        try {
          const { rebalance } = await import("./rebalance.js");
          await rebalance({ dryRun: process.env.RT_REBALANCE_DRY === "1" });
        } catch (err) {
          warn(`rebalance failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      try {
        await this.walkScenario(s);
      } catch (err) {
        fail(`${s.id} crashed: ${err instanceof Error ? err.message : String(err)}`);
        this.results.push({
          scenarioId: s.id,
          outcome: "crashed",
          notes: [err instanceof Error ? err.message : String(err)],
        });
      }
    }

    // Attack lane. Same SCENARIO_FILTER applies (skipped entirely if
    // filter is set and no attack id matches — smoke runs typically
    // skip attacks).
    const attackList = this.cfg.attack_scenarios.filter(
      (a) => filter.length === 0 || filter.includes(a.id),
    );
    for (const a of attackList) {
      try {
        const r = await this.walkAttack(a);
        this.attackResults.push(r);
      } catch (err) {
        this.attackResults.push({
          scenarioId: a.id,
          attack: a.attack,
          expectedDefenseLayer: a.expected_defense_layer,
          defenseHeld: false,
          observed: `runner crashed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const endSnapshot = await this.snap();
    const finishedAt = new Date().toISOString();
    const drift = endSnapshot.totalUsdc - (this.startSnapshot?.totalUsdc ?? 0n);

    const byActor = this.actors.map((a) => ({
      address: a.address,
      name: a.name,
      deltaWei:
        (endSnapshot.walletBalances[a.address] ?? 0n) -
        (this.startSnapshot!.walletBalances[a.address] ?? 0n),
    }));

    const audit: BattleAudit = {
      startedAt,
      finishedAt,
      scenariosRun: lifecycleScenarios.length,
      conservedOverall: drift === 0n,
      chainTotalDriftWei: drift,
      perQuestion: this.auditedScenarios,
      byActor,
      sybilFindings: this.sybilFindings,
      attackVectors: this.attackResults,
    };

    return audit;
  }

  // ─ Happy-path / sybil walker ──────────────────────────────────

  private async walkScenario(s: Scenario | SybilScenario): Promise<void> {
    log(s.id, c.bold(s.title));
    const sponsorWallet = this.wallets[s.sponsor];
    if (!sponsorWallet) throw new Error(`sponsor wallet '${s.sponsor}' not in pool`);

    // 1) Authed sponsor + create question (free L1 first; sponsor amount comes via /fund).
    const sponsor = await loginWallet(sponsorWallet);
    const question = await call<{ id: string; successCriteria: { id: string; name: string }[] }>(
      "POST",
      "/v1/questions",
      {
        title: s.title,
        description: s.description ?? s.title,
        successCriteria: s.success_criteria.map((sc) => ({
          name: sc.name,
          type: sc.type,
          target: sc.target,
          weight: sc.weight,
        })),
        initialBounty: "0",
      },
      sponsor.token,
    );
    ok(`question ${question.id}`);

    // 2) Sponsor fund — v2 runSponsorFlow (preflight → sign Envelope →
    //    POST /intents → sponsorSubmit). Pre-approve USDC once (no EIP-2612).
    const sponsorPre = await preflightV2<FundPreflight>(
      question.id, "sponsor", "sponsor", sponsor.address, sponsor.token,
    );
    if (sponsorPre.mode !== "sponsor") {
      throw new Error(`expected mode=sponsor, got ${sponsorPre.mode}`);
    }
    const qid = sponsorPre.qid as Hex;
    this.knownQids.push(qid);
    const sponsorAmountWei = parseAmountToWei("1", sponsorPre.token.decimals);
    const sponsorWalletClient = this.makeWalletClient(sponsorWallet);
    await ensureUsdcAllowance(sponsorWalletClient, publicClient, {
      usdc: USDC, forge: FORGE!, owner: sponsor.address, required: sponsorAmountWei,
    });
    const sponsorFees = feeShareFromPreflight(sponsorPre, this.defaultFeeRecipient());
    const sponsorResult = await runSponsorFlow({
      baseUrl: BACKEND, bearerToken: sponsor.token, signer: sponsor.address,
      questionId: question.id, qid, nonce: BigInt(sponsorPre.nonce ?? "0"),
      expiresAt: BigInt(sponsorPre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
      forgeAddress: FORGE!, chainId: sponsorPre.chainId ?? CHAIN_ID,
      expectedIntentHash: sponsorPre.expectedIntentHash as Hex,
      title: s.title, body: s.description ?? s.title,
      criteria: JSON.stringify(s.success_criteria), tags: ["battle"],
      oracle: (sponsorPre.oracle as Address | undefined) ?? this.wallets["operator"].address as Address,
      sponsorshipFloor: BigInt(sponsorPre.sponsorshipFloor ?? sponsorPre.recommendedSponsorshipFloor ?? "0"),
      commitFee: BigInt(sponsorPre.commitFee ?? "0"),
      voteFee: BigInt(sponsorPre.voteFee ?? "0"),
      stakeFloor: BigInt(sponsorPre.stakeFloor ?? "0"),
      stakeBasisPoints: Number(sponsorPre.stakeBasisPoints ?? "0"),
      fundingDeadline: BigInt(sponsorPre.recommendedFundingDeadline ?? Math.floor(Date.now() / 1000) + 30 * 86400),
      noSolutionGracePeriod: BigInt(sponsorPre.noSolutionGracePeriod ?? "86400"),
      token: sponsorPre.token.contractAddress as Address, amount: sponsorAmountWei, feeAmount: 0n,
      feeShareBps: sponsorFees.feeShareBps,
      feeShares: [{ recipient: sponsorFees.platformFeeRecipient, basisPoints: 10000 }],
      walletClient: sponsorWalletClient, privateKey: sponsorWallet.privateKey as Hex,
    });
    await awaitReceipt(publicClient, sponsorResult.txHash!);
    ok(`sponsor on-chain (intent ${sponsorResult.intentHash.slice(0, 12)}…)`);

    let poolInflows = sponsorAmountWei;

    // 3) Cosponsors (optional) — v2 runCosponsorFlow.
    for (const cosponsorLetter of (s as Scenario).cosponsors ?? []) {
      const wallet = this.wallets[cosponsorLetter];
      const ca = await loginWallet(wallet);
      const cosponsorPre = await preflightV2<FundPreflight>(
        question.id, "cosponsor", "sponsor", ca.address, ca.token,
      );
      if (cosponsorPre.mode !== "cosponsor") {
        throw new Error(`expected mode=cosponsor, got ${cosponsorPre.mode}`);
      }
      const amountWei = parseAmountToWei("0.5", cosponsorPre.token.decimals);
      const wc = this.makeWalletClient(wallet);
      await ensureUsdcAllowance(wc, publicClient, {
        usdc: USDC, forge: FORGE!, owner: ca.address, required: amountWei,
      });
      const result = await runCosponsorFlow({
        baseUrl: BACKEND, bearerToken: ca.token, signer: ca.address,
        questionId: question.id, qid, nonce: BigInt(cosponsorPre.nonce ?? "0"),
        expiresAt: BigInt(cosponsorPre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
        forgeAddress: FORGE!, chainId: cosponsorPre.chainId ?? CHAIN_ID,
        expectedIntentHash: cosponsorPre.expectedIntentHash as Hex,
        token: cosponsorPre.token.contractAddress as Address, amount: amountWei, feeAmount: 0n,
        // No feeShares — cosponsor inherits the frozen sponsor policy;
        // the flow hardcodes the empty array (chain shape gate + backend
        // preflight bake empty, so any caller value would drift the hash).
        walletClient: wc, privateKey: wallet.privateKey as Hex,
      });
      await awaitReceipt(publicClient, result.txHash!);
      ok(`cosponsor ${cosponsorLetter} +${fmtUsdc6(amountWei)} USDC`);
      poolInflows += amountWei;
    }

    // 4) Solvers commit — v2 runCommitFlow (submit env). The structured
    //    solution body is canonical-JSON'd into CommitWitness.solutionBody;
    //    the backend derives the same contentHash from it.
    const solutionsByLetter: Record<string, { id: string; intentHash: Hex; stake: bigint; submitter: AuthedWallet }> = {};
    let stakesCommitted = 0n;
    for (const solverLetter of s.solvers) {
      const wallet = this.wallets[solverLetter];
      const sa = await loginWallet(wallet);
      const commitPre = await preflightV2<CommitPreflight>(
        question.id, "commit", "submitter", sa.address, sa.token,
      );
      const body = makeSolutionBody(solverLetter, s.id);
      const solutionPayload = {
        body,
        reasoningTree: [
          { because: `${solverLetter} examined the live workload first`, therefore: "ALTER TABLE without NOT VALID would lock writers for the validation scan" },
          { because: "Validation scan walks every row at AccessExclusiveLock", therefore: "use ADD CONSTRAINT … NOT VALID then VALIDATE CONSTRAINT separately" },
          { because: "VALIDATE CONSTRAINT acquires only ShareUpdateExclusiveLock", therefore: "concurrent writers can keep going while the constraint is verified" },
          { because: "New rows must satisfy NOT NULL from the moment of cutover", therefore: "wire dual-write through the application before the constraint flips" },
          { because: "Backfill chunks must not deadlock with live writers", therefore: "use SELECT FOR UPDATE SKIP LOCKED with idempotent UPSERTs in 10k-row batches" },
          { because: "Replication slots inflate WAL during long backfills", therefore: "monitor pg_replication_slots and pause if the slot retention nears disk" },
        ],
        claims: s.success_criteria.map((sc, i) => ({
          criterionId: question.successCriteria[i].id,
          value: true,
          argument: `claim against ${sc.name}`,
          falsifiableBy: "audit failure",
        })),
      };
      const fee = BigInt(commitPre.feeAmount);
      const stake = BigInt(commitPre.stakeAmount);
      const wc = this.makeWalletClient(wallet);
      await ensureUsdcAllowance(wc, publicClient, {
        usdc: USDC, forge: FORGE!, owner: sa.address, required: fee + stake,
      });
      const fees = feeShareFromPreflight(commitPre, this.defaultFeeRecipient());
      const result = await runCommitFlow({
        baseUrl: BACKEND, bearerToken: sa.token, signer: sa.address,
        questionId: question.id, qid, nonce: BigInt(commitPre.nonce ?? "0"),
        expiresAt: BigInt(commitPre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
        forgeAddress: FORGE!, chainId: commitPre.chainId ?? CHAIN_ID,
        solutionBody: canonicalStringify(solutionPayload), references: [],
        token: commitPre.token.contractAddress as Address, feeAmount: fee, stakeAmount: stake,
        feeShareBps: fees.feeShareBps, feeShares: fees.feeShares,
        walletClient: wc, privateKey: wallet.privateKey as Hex,
      });
      await awaitReceipt(publicClient, result.txHash!);
      const intentHash = result.intentHash;
      this.knownCommits.push(intentHash);
      ok(`commit ${solverLetter} intent=${intentHash.slice(0, 12)}… stake=${fmtUsdc6(stake)}`);
      // In v2 the on-chain solutionId IS the commit intentHash. The
      // human sol_xxx id isn't needed for the vote step (it resolves via
      // ?include=solutions), so we key the map on the intentHash.
      solutionsByLetter[solverLetter] = { id: intentHash, intentHash, stake, submitter: sa };
      // Realized-outcome model: commit carries feeAmount=0 (the fee is
      // skimmed once at settlement, docs/economics.md §0). This add is
      // inert under the default zero commitFee; it only contributes if a
      // sponsor set a non-zero (deprecated) commitFee, in which case that
      // fee lands in the pool exactly as accounted here.
      poolInflows += fee;
      stakesCommitted += stake;
    }

    // 5) Voters cast — v2 runVoteFlow. Allocation.solutionId is the
    //    on-chain bytes32 commit intentHash (solutionsByLetter[].intentHash);
    //    points (sum=100) map to basis points (×100, sum=10000).
    const winnerSolution = solutionsByLetter[s.intended_winner_profile];
    if (!winnerSolution) {
      throw new Error(`intended_winner '${s.intended_winner_profile}' has no solution`);
    }
    const votesByLetter: Record<string, { intentHash: Hex; stake: bigint }> = {};
    let voteStakesCommitted = 0n;
    for (const voterLetter of s.voters) {
      const wallet = this.wallets[voterLetter];
      const va = await loginWallet(wallet);
      const votePre = await preflightV2<VotePreflight>(
        question.id, "vote", "voter", va.address, va.token,
      );
      // Build point allocations: self-vote sybils → 100% winner; honest
      // voters → 80% winner / 20% across runners-up. Then resolve each
      // solverLetter → its commit intentHash + map points → bps.
      const pointAllocs: { letter: string; points: number }[] = [];
      const isSybilSelfVote = voterLetter === s.intended_winner_profile;
      if (isSybilSelfVote) {
        pointAllocs.push({ letter: s.intended_winner_profile, points: 100 });
      } else {
        const others = s.solvers.filter((l) => l !== s.intended_winner_profile);
        if (others.length === 0) {
          pointAllocs.push({ letter: s.intended_winner_profile, points: 100 });
        } else {
          pointAllocs.push({ letter: s.intended_winner_profile, points: 80 });
          const share = Math.floor(20 / others.length);
          let assigned = 80;
          for (let i = 0; i < others.length; i++) {
            const pts = i === others.length - 1 ? 100 - assigned : share;
            assigned += pts;
            pointAllocs.push({ letter: others[i], points: pts });
          }
        }
      }
      const allocations = pointAllocs
        .map((pa) => {
          const sol = solutionsByLetter[pa.letter];
          return sol ? { solutionId: sol.intentHash, basisPoints: pa.points * 100 } : null;
        })
        .filter((a): a is { solutionId: Hex; basisPoints: number } => a !== null);

      if (!votePre.voteSalt || !votePre.voteSaltToken) {
        throw new Error(`vote preflight missing voteSalt; backend requires it for privacy`);
      }
      const fee = BigInt(votePre.feeAmount);
      const stake = BigInt(votePre.stakeAmount);
      const wc = this.makeWalletClient(wallet);
      await ensureUsdcAllowance(wc, publicClient, {
        usdc: USDC, forge: FORGE!, owner: va.address, required: fee + stake,
      });
      const fees = feeShareFromPreflight(votePre, this.defaultFeeRecipient());
      const result = await runVoteFlow({
        baseUrl: BACKEND, bearerToken: va.token, signer: va.address,
        questionId: question.id, qid, nonce: BigInt(votePre.nonce ?? "0"),
        // expiresAt MUST equal voteSaltExpiresAt — the HMAC binds it.
        expiresAt: BigInt(votePre.voteSaltExpiresAt!),
        forgeAddress: FORGE!, chainId: votePre.chainId ?? CHAIN_ID,
        expectedIntentHash: votePre.expectedIntentHash as Hex,
        allocations,
        voteSalt: votePre.voteSalt as Hex, voteSaltToken: votePre.voteSaltToken as Hex,
        token: votePre.token.contractAddress as Address, feeAmount: fee, stakeAmount: stake,
        feeShareBps: fees.feeShareBps, feeShares: fees.feeShares,
        walletClient: wc, privateKey: wallet.privateKey as Hex,
      });
      await awaitReceipt(publicClient, result.txHash!);
      const intentHash = result.intentHash;
      this.knownVotes.push(intentHash);
      ok(`vote ${voterLetter} stake=${fmtUsdc6(stake)}`);
      votesByLetter[voterLetter] = { intentHash, stake };
      // Realized-outcome model: vote carries feeAmount=0 (fee at
      // settlement only). Inert under the default zero voteFee — see the
      // matching note in the commit step.
      poolInflows += fee;
      voteStakesCommitted += stake;
    }

    // 6) Settle — v2: the BACKEND ORACLE KEEPER owns settlement (it
    //    builds the SettleWitness, signs once, broadcasts
    //    publishSettlement). The harness no longer computes a merkle
    //    tree client-side; it awaits the keeper flipping the question to
    //    Settled on chain (poll getQuestionScalars.status == 3).
    //
    // Realized-outcome fee: the fee is skimmed ONCE at settlement and
    // credited to the platform recipient's cross-question accruedFees
    // tab (docs/economics.md §0). accruedFees is a GLOBAL mapping, so we
    // snapshot the platform recipient's balance BEFORE settle and diff
    // it AFTER the sweep to isolate THIS question's feeTotal. Scenarios
    // run serially, so no concurrent question pollutes the delta. The
    // delta is the value `withdrawFees` would pay (net of prior
    // withdrawals) — the audit reconciles against accrued, not a
    // realized transfer (the sweeper may not have run yet).
    const settleToken = sponsorPre.token.contractAddress as Address;
    const platformFeeRecipient = sponsorFees.platformFeeRecipient;
    const accruedBefore = await readAccruedFees({
      publicClient, forge: FORGE!, recipient: platformFeeRecipient, token: settleToken,
    });
    const STATUS_SETTLED = 3;
    const settleDeadline = Date.now() + this.settleWaitMs;
    let settledStatus = 0;
    while (settledStatus !== STATUS_SETTLED) {
      const scalars = (await publicClient.readContract({
        address: FORGE!, abi: FORGE_READ_ABI, functionName: "getQuestionScalars", args: [qid],
      })) as readonly [Address, number, bigint, boolean];
      settledStatus = Number(scalars[1]);
      if (settledStatus === STATUS_SETTLED) break;
      if (Date.now() >= settleDeadline) {
        warn(`settle: keeper did not settle ${qid.slice(0, 12)}… within ${this.settleWaitMs / 1000}s (status=${settledStatus}) — recording lifecycle without payout sweep`);
        break;
      }
      await new Promise((r) => setTimeout(r, 8_000));
    }
    if (settledStatus === STATUS_SETTLED) ok("settle (keeper-published) ✓");

    // 7+8) Money-out — v2 unified withdraw door per participant
    //       (runClaimFlow winner payout + runRefundFlow stake/sponsor
    //       refunds). One door call enumerates everything each wallet is
    //       owed. Soft-fail so a payout revert doesn't abort the battle.
    // Money-out, split by what's OWED (from the withdraw-door draft) vs
    // PULLED (broadcast succeeded). The realized-outcome ledger
    // reconciles owed quantities so an unpulled refund (timing) doesn't
    // read as drift: unpulled winner claims stay in the chain pool
    // (finalPool), unpulled stake refunds stay in escrow (escrowRemaining
    // = owed − pulled).
    let stakeRefundsPulled = 0n;
    let stakeRefundsOwed = 0n;
    let winnerClaimsPulled = 0n;
    if (settledStatus === STATUS_SETTLED) {
      const sweepOpts: SweepOptions = {
        apiBase: BACKEND, forgeAddress: FORGE!, rpcUrl: RPC, chainId: CHAIN_ID, dryRun: false,
      };
      const participants = new Set<string>([
        ...Object.values(solutionsByLetter).map((v) => v.submitter.address.toLowerCase()),
        ...s.voters.map((l) => this.wallets[l].address.toLowerCase()),
        this.wallets[s.sponsor].address.toLowerCase(),
      ]);
      for (const addrLower of participants) {
        const wallet = this.walletByAddress(addrLower);
        if (!wallet) continue;
        try {
          const auth = await loginWallet(wallet.agentWallet);
          const r = await sweepWalletQuestion(
            sweepOpts,
            { index: wallet.index, address: wallet.agentWallet.address as Address, privateKey: wallet.agentWallet.privateKey as Hex },
            auth.token,
            question.id,
          );
          for (const item of r.items) {
            if (item.actionType === "claim") {
              // Unpulled claims remain in the chain pool → counted via
              // finalPool, so only ACCUMULATE pulled claims here.
              if (item.status === "broadcast") winnerClaimsPulled += item.amountWei;
            } else {
              // refund: sponsor bounty refund or commit/vote stake-back.
              // owedWei is from the draft (independent of broadcast) so
              // a not-yet-pulled refund still balances via escrowRemaining.
              stakeRefundsOwed += item.owedWei;
              if (item.status === "broadcast") stakeRefundsPulled += item.amountWei;
            }
          }
        } catch (err) {
          warn(`withdraw ${addrLower.slice(0, 10)}… failed (lifecycle still recorded): ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        }
      }
      ok(`money-out swept: claims ${fmtUsdc6(winnerClaimsPulled)} + refunds ${fmtUsdc6(stakeRefundsPulled)}/${fmtUsdc6(stakeRefundsOwed)} owed USDC`);
    }

    // Sybil flag.
    const sybilLinks = (s as SybilScenario).sybil_links;
    if (sybilLinks?.length) {
      for (const grp of sybilLinks) {
        this.sybilFindings.push(`${s.id}:linked:${grp.join("-")}`);
      }
    }

    // Reconcile per-question with the realized-outcome ledger
    // (docs/economics.md §0). Read the post-sweep chain state:
    //   - getQuestionScalars: status (terminal outcome) + poolAmount
    //     (the still-claimable winner residual for unpulled merkle leaves).
    //   - accruedFees delta: the feeTotal skimmed at settlement and
    //     credited to the platform recipient's tab (the value
    //     withdrawFees would pay), reconciled as ACCRUED, not transferred.
    const finalScalars = (await publicClient.readContract({
      address: FORGE!, abi: FORGE_READ_ABI, functionName: "getQuestionScalars", args: [qid],
    })) as readonly [Address, number, bigint, boolean];
    const finalStatus = Number(finalScalars[1]);
    const finalPool = finalScalars[2];

    const accruedAfter = await readAccruedFees({
      publicClient, forge: FORGE!, recipient: platformFeeRecipient, token: settleToken,
    });
    const feeAccrued = accruedAfter - accruedBefore;

    // Map the on-chain terminal status to the audit outcome. Settled=3 →
    // fee at settlement; Abandoned=4 / Recovered=5 → full refund, zero
    // fee. Anything else (didn't reach a terminal state within the
    // settle-wait window) is treated as settled-pending so an unsettled
    // question doesn't masquerade as abandoned.
    const outcome: QuestionOutcome =
      finalStatus === 4 ? "abandoned" : finalStatus === 5 ? "recovered" : "settled";

    // Stakes still owed-but-not-pulled remain in escrow; they keep the
    // ledger balanced regardless of money-out timing.
    const escrowRemaining = stakeRefundsOwed - stakeRefundsPulled;

    const trace: QuestionTrace = {
      scenarioId: s.id,
      qid,
      outcome,
      poolInflowsWei: poolInflows,
      stakesCommittedWei: stakesCommitted + voteStakesCommitted,
      winnerClaimsPulledWei: winnerClaimsPulled,
      stakeRefundsPulledWei: stakeRefundsPulled,
      feeAccruedWei: feeAccrued,
    };
    const audit = reconcileQuestion(trace, finalPool, escrowRemaining);
    this.auditedScenarios.push(audit);
    if (audit.conserves) ok(`conserves ✓ (drift 0, fee accrued ${fmtUsdc6(feeAccrued)})`);
    else fail(`drift ${audit.drift.toString()} wei — ${audit.notes.join("; ")}`);

    this.results.push({
      scenarioId: s.id,
      outcome: audit.conserves ? "success" : "drifted",
      notes: audit.notes,
    });
  }

  // ─ Attack lane ────────────────────────────────────────────────

  // Build + sign a v2 Envelope with arbitrary (possibly corrupted)
  // fields, then POST it raw to /v1/questions/:id/intents — bypassing
  // the run*Flow hash-match guard so the attack can deliberately drift a
  // field. Returns the HTTP result so the attack can assert Stage-2
  // rejection. Used by the corruption attacks below.
  private async signAndPostRawEnvelope(params: {
    wallet: AgentWallet;
    bearer: string;
    questionId: string;
    actionType: string;
    envelope: Envelope;
    content: Record<string, unknown>;
    expectedIntentHash?: Hex;
    voteSaltToken?: string;
  }): Promise<void> {
    const typedData = buildEnvelopeForSigning({
      envelope: params.envelope,
      chainId: CHAIN_ID,
      forgeAddress: FORGE!,
    });
    const account = privateKeyToAccount(params.wallet.privateKey as Hex);
    const signature = (await account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message as never,
    })) as Hex;
    const body = stringifyWithBigInts({
      actionType: params.actionType,
      typedData: serializeEnvelope(params.envelope),
      content: params.content,
      signature,
      expectedIntentHash:
        params.expectedIntentHash ?? hashEnvelopeStruct(params.envelope),
      ...(params.voteSaltToken ? { voteSaltToken: params.voteSaltToken } : {}),
    });
    const res = await fetchWithRetry(
      `${BACKEND}/v1/questions/${params.questionId}/intents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.bearer}`,
        },
        body,
      },
    );
    const raw = await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
    if (!res.ok) throw new HttpError("POST", `/v1/questions/${params.questionId}/intents`, res.status, parsed);
  }

  private async walkAttack(a: AttackScenario): Promise<AttackResult> {
    log(a.id, c.bold(a.title));
    const sponsor = await loginWallet(this.wallets["mallory"]);

    // Each attack builds a real v2 envelope then deliberately corrupts
    // ONE field. The ASSERT is: the violation is rejected at the layer
    // declared in `expected_defense_layer`. Corruptions that the chain
    // owns (sub-floor stake, nonce reuse) are broadcast directly; ones
    // the backend Stage-2 owns (expired, fee-share cap) POST raw.

    // Helper: build a SponsorWitness + Envelope(Sponsor) with arbitrary
    // overrides for the corruption attacks.
    const buildAttackSponsorEnvelope = (
      pre: FundPreflight,
      signer: Address,
      overrides: { expiresAt?: bigint; feeShareBps?: number; feeShares?: { recipient: Address; basisPoints: number }[] },
    ): { envelope: Envelope; content: Record<string, unknown> } => {
      const amountWei = parseAmountToWei("1", pre.token.decimals);
      const { witness, contentHash } = buildSponsorWitness({
        title: "attack", body: "attack", criteria: "[]", tags: ["attack"],
        oracle: (pre.oracle as Address | undefined) ?? signer,
        sponsorshipFloor: BigInt(pre.sponsorshipFloor ?? pre.recommendedSponsorshipFloor ?? "0"),
        commitFee: BigInt(pre.commitFee ?? "0"),
        voteFee: BigInt(pre.voteFee ?? "0"),
        stakeFloor: BigInt(pre.stakeFloor ?? "0"),
        stakeBasisPoints: Number(pre.stakeBasisPoints ?? "0"),
        fundingDeadline: BigInt(pre.recommendedFundingDeadline ?? Math.floor(Date.now() / 1000) + 30 * 86400),
        noSolutionGracePeriod: BigInt(pre.noSolutionGracePeriod ?? "86400"),
      });
      const funds: Funds = {
        token: pre.token.contractAddress as Address,
        poolIn: amountWei, poolOut: 0n, feeAmount: 0n,
        feeShareBps: overrides.feeShareBps ?? Number(pre.feeShareBps ?? 0),
        feeShares: overrides.feeShares ?? [{ recipient: this.defaultFeeRecipient(), basisPoints: 10000 }],
        stakeAmount: 0n, stakeOp: StakeOp.None,
      };
      const envelope: Envelope = {
        signer, qid: pre.qid as Hex, action: ActionTag.Sponsor,
        nonce: BigInt(pre.nonce ?? "0"),
        expiresAt: overrides.expiresAt ?? BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
        contentHash, funds,
      };
      return { envelope, content: serializeSponsorWitness(witness) };
    };

    if (a.attack === "expired_intent") {
      // Sign an envelope whose expiresAt is already in the past; POST it
      // raw. Backend Stage-2 (intent.expiresAt not past) must reject.
      const question = await this.makeQuestion(sponsor, "Expired-intent test");
      const pre = await preflightV2<FundPreflight>(
        question.id, "sponsor", "sponsor", sponsor.address, sponsor.token,
      );
      const { envelope, content } = buildAttackSponsorEnvelope(pre, sponsor.address, {
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 60),
      });
      try {
        await this.signAndPostRawEnvelope({
          wallet: this.wallets["mallory"], bearer: sponsor.token,
          questionId: question.id, actionType: "sponsor", envelope, content,
        });
        return this.attackFailed(a, "backend accepted expired intent");
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status === 400 || err.status === 422) {
            return this.attackHeld(a, `backend ${err.status} ${err.errorCode()}`);
          }
          return this.attackFailed(a, `unexpected ${err.status} ${err.errorCode()}`);
        }
        throw err;
      }
    }

    if (a.attack === "feeshare_cap_violation") {
      // Over-cap feeShareBps in the funds shape; backend Stage-2 +
      // chain funds-shape gate reject.
      const question = await this.makeQuestion(sponsor, "feeshare-cap test");
      const pre = await preflightV2<FundPreflight>(
        question.id, "sponsor", "sponsor", sponsor.address, sponsor.token,
      );
      const { envelope, content } = buildAttackSponsorEnvelope(pre, sponsor.address, {
        feeShareBps: 9999,
        feeShares: [{ recipient: sponsor.address, basisPoints: 9999 }],
      });
      try {
        await this.signAndPostRawEnvelope({
          wallet: this.wallets["mallory"], bearer: sponsor.token,
          questionId: question.id, actionType: "sponsor", envelope, content,
        });
        return this.attackFailed(a, "backend accepted over-cap feeShareBps");
      } catch (err) {
        if (err instanceof HttpError && (err.status === 400 || err.status === 422)) {
          return this.attackHeld(a, `backend ${err.status} ${err.errorCode() ?? "?"}`);
        }
        return this.attackFailed(a, `unexpected ${err instanceof Error ? err.message : err}`);
      }
    }

    if (a.attack === "subfloor_stake") {
      // Commit with stakeAmount = floor − 1. Build the envelope raw,
      // pre-approve USDC, broadcast submit(); the chain's stake-floor
      // require() must revert.
      const honestSponsor = await loginWallet(this.wallets["alice"]);
      const question = await this.makeQuestion(honestSponsor, "subfloor-stake test");
      await this.sponsorFund(honestSponsor, question.id, "1");
      const solver = await loginWallet(this.wallets["mallory"]);
      const pre = await preflightV2<CommitPreflight>(
        question.id, "commit", "submitter", solver.address, solver.token,
      );
      const recommendedStake = BigInt(pre.stakeAmount || "0");
      if (recommendedStake === 0n) {
        return this.attackFailed(a, "preflight returned 0 stake — cannot test sub-floor");
      }
      const subFloor = recommendedStake - 1n;
      const fee = BigInt(pre.feeAmount);
      const { witness, contentHash } = buildCommitWitness({
        solutionBody: canonicalStringify({ body: `subfloor-${a.id}`, reasoningTree: [], claims: [] }),
        references: [],
      });
      const fees = feeShareFromPreflight(pre, this.defaultFeeRecipient());
      const funds: Funds = {
        token: pre.token.contractAddress as Address,
        poolIn: 0n, poolOut: 0n, feeAmount: fee,
        feeShareBps: fees.feeShareBps, feeShares: fees.feeShares,
        stakeAmount: subFloor, stakeOp: StakeOp.Lock,
      };
      const envelope: Envelope = {
        signer: solver.address, qid: pre.qid as Hex, action: ActionTag.Commit,
        nonce: BigInt(pre.nonce ?? "0"),
        expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
        contentHash, funds,
      };
      const wc = this.makeWalletClient(this.wallets["mallory"]);
      try {
        await ensureUsdcAllowance(wc, publicClient, {
          usdc: USDC, forge: FORGE!, owner: solver.address, required: fee + subFloor,
        });
        const account = privateKeyToAccount(this.wallets["mallory"].privateKey as Hex);
        const typedData = buildEnvelopeForSigning({ envelope, chainId: CHAIN_ID, forgeAddress: FORGE! });
        const sig = (await account.signTypedData({
          domain: typedData.domain, types: typedData.types,
          primaryType: typedData.primaryType, message: typedData.message as never,
        })) as Hex;
        await broadcastSubmit(wc, { forgeAddress: FORGE!, envelope, signature: sig });
        return this.attackFailed(a, "chain accepted sub-floor stake");
      } catch (chainErr) {
        return this.attackHeld(a, `chain reverted: ${chainErr instanceof Error ? chainErr.message.slice(0, 120) : "?"}`);
      }
    }

    if (a.attack === "nonce_reuse") {
      // Broadcast a valid sponsorSubmit, then re-broadcast the SAME
      // envelope+sig — the contract's nonce bitmap must reject the
      // replay (consumed nonce).
      const honest = await loginWallet(this.wallets["alice"]);
      const question = await this.makeQuestion(honest, "nonce-reuse test");
      const pre = await preflightV2<FundPreflight>(
        question.id, "sponsor", "sponsor", honest.address, honest.token,
      );
      const amountWei = parseAmountToWei("1", pre.token.decimals);
      const { witness, contentHash } = buildSponsorWitness({
        title: "nonce-reuse", body: "nonce-reuse", criteria: "[]", tags: ["attack"],
        oracle: (pre.oracle as Address | undefined) ?? honest.address,
        sponsorshipFloor: BigInt(pre.sponsorshipFloor ?? pre.recommendedSponsorshipFloor ?? "0"),
        commitFee: BigInt(pre.commitFee ?? "0"), voteFee: BigInt(pre.voteFee ?? "0"),
        stakeFloor: BigInt(pre.stakeFloor ?? "0"), stakeBasisPoints: Number(pre.stakeBasisPoints ?? "0"),
        fundingDeadline: BigInt(pre.recommendedFundingDeadline ?? Math.floor(Date.now() / 1000) + 30 * 86400),
        noSolutionGracePeriod: BigInt(pre.noSolutionGracePeriod ?? "86400"),
      });
      const fees = feeShareFromPreflight(pre, this.defaultFeeRecipient());
      const funds: Funds = {
        token: pre.token.contractAddress as Address,
        poolIn: amountWei, poolOut: 0n, feeAmount: 0n,
        feeShareBps: fees.feeShareBps, feeShares: [{ recipient: fees.platformFeeRecipient, basisPoints: 10000 }],
        stakeAmount: 0n, stakeOp: StakeOp.None,
      };
      const envelope: Envelope = {
        signer: honest.address, qid: pre.qid as Hex, action: ActionTag.Sponsor,
        nonce: BigInt(pre.nonce ?? "0"),
        expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
        contentHash, funds,
      };
      const wc = this.makeWalletClient(this.wallets["alice"]);
      await ensureUsdcAllowance(wc, publicClient, {
        usdc: USDC, forge: FORGE!, owner: honest.address, required: amountWei,
      });
      const account = privateKeyToAccount(this.wallets["alice"].privateKey as Hex);
      const typedData = buildEnvelopeForSigning({ envelope, chainId: CHAIN_ID, forgeAddress: FORGE! });
      const sig = (await account.signTypedData({
        domain: typedData.domain, types: typedData.types,
        primaryType: typedData.primaryType, message: typedData.message as never,
      })) as Hex;
      const tx = await broadcastSponsorSubmit(wc, { forgeAddress: FORGE!, envelope, signature: sig, witness });
      await awaitReceipt(publicClient, tx);
      try {
        await broadcastSponsorSubmit(wc, { forgeAddress: FORGE!, envelope, signature: sig, witness });
        return this.attackFailed(a, "chain accepted nonce reuse");
      } catch (err) {
        return this.attackHeld(a, `chain reverted: ${err instanceof Error ? err.message.slice(0, 120) : "?"}`);
      }
    }

    if (a.attack === "late_vote") {
      // Without time travel on Base Sepolia we can't fast-forward a
      // deadline. Marked skipped (unchanged from v1).
      return {
        scenarioId: a.id,
        attack: a.attack,
        expectedDefenseLayer: a.expected_defense_layer,
        defenseHeld: false,
        observed: "skipped — Base Sepolia cannot fast-forward; run manual deadline test once Phase E timing harness lands",
      };
    }

    if (a.attack === "frontrun_claim") {
      // Mallory tries to claim() against a non-existent settlement
      // (bogus qid + empty proof). Claim is now PERMISSIONLESS + unsigned
      // (the Merkle proof IS the auth), so the attack is a direct
      // claim() call — the chain must revert on the proof/status check
      // (claim:question-not-settled or claim:invalid-proof).
      const honest = await loginWallet(this.wallets["alice"]);
      const question = await this.makeQuestion(honest, "frontrun-claim test");
      await this.sponsorFund(honest, question.id, "1");
      const mallory = this.wallets["mallory"];
      const fakeQid = ("0x" + "ab".repeat(32)) as Hex;
      const wc = this.makeWalletClient(mallory);
      try {
        await broadcastClaim(wc, {
          forgeAddress: FORGE!,
          qid: fakeQid,
          // Mallory names herself the recipient — pay-to-recipient is
          // structural but the proof can't authorise a bogus leaf.
          recipient: mallory.address as Address,
          role: 0,
          leafIndex: 0n,
          leafAmount: parseAmountToWei("1", 6),
          proof: [],
        });
        return this.attackFailed(a, "chain accepted bogus claim");
      } catch (err) {
        return this.attackHeld(a, `chain reverted: ${err instanceof Error ? err.message.slice(0, 120) : "?"}`);
      }
    }

    return this.attackFailed(a, `unhandled attack '${a.attack}'`);
  }

  // ─ Helpers ────────────────────────────────────────────────────

  // Fee-share recipient for smoke runs (zero-fee bucket routes here).
  // Aliases the demo fee_wallet (carol) or operator.
  private defaultFeeRecipient(): Address {
    const feeWallet = this.wallets["fee_wallet"] ?? this.wallets["operator"];
    return feeWallet.address as Address;
  }

  private makeWalletClient(w: AgentWallet) {
    return makeAgentWalletClient({
      privateKey: w.privateKey,
      chainId: CHAIN_ID,
      rpcUrl: RPC,
    });
  }

  private async makeQuestion(authed: AuthedWallet, title: string): Promise<{ id: string; successCriteria: { id: string }[] }> {
    return await call<{ id: string; successCriteria: { id: string }[] }>(
      "POST",
      "/v1/questions",
      {
        title,
        description: title,
        successCriteria: [
          { name: "primary", type: "boolean", target: "true", weight: 100 },
        ],
        initialBounty: "1000000",
        bountyCurrency: "USD",
        tags: ["battle-attack"],
      },
      authed.token,
    );
  }

  // v2 sponsor-fund helper for the attack lane setup. Uses runSponsorFlow
  // (preflight → sign → POST /intents → sponsorSubmit); pre-approves USDC.
  private async sponsorFund(authed: AuthedWallet, questionId: string, humanAmount: string): Promise<void> {
    const pre = await preflightV2<FundPreflight>(
      questionId, "sponsor", "sponsor", authed.address, authed.token,
    );
    const amountWei = parseAmountToWei(humanAmount, pre.token.decimals);
    const wc = this.makeWalletClient(authed.wallet);
    await ensureUsdcAllowance(wc, publicClient, {
      usdc: USDC, forge: FORGE!, owner: authed.address, required: amountWei,
    });
    const fees = feeShareFromPreflight(pre, this.defaultFeeRecipient());
    const result = await runSponsorFlow({
      baseUrl: BACKEND, bearerToken: authed.token, signer: authed.address,
      questionId, qid: pre.qid as Hex, nonce: BigInt(pre.nonce ?? "0"),
      expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
      forgeAddress: FORGE!, chainId: pre.chainId ?? CHAIN_ID,
      expectedIntentHash: pre.expectedIntentHash as Hex,
      title: `attack-setup ${questionId}`, body: `attack-setup ${questionId}`,
      criteria: JSON.stringify([{ name: "primary", type: "boolean", target: "true", weight: 100 }]),
      tags: ["battle-attack"],
      oracle: (pre.oracle as Address | undefined) ?? this.wallets["operator"].address as Address,
      sponsorshipFloor: BigInt(pre.sponsorshipFloor ?? pre.recommendedSponsorshipFloor ?? "0"),
      commitFee: BigInt(pre.commitFee ?? "0"),
      voteFee: BigInt(pre.voteFee ?? "0"),
      stakeFloor: BigInt(pre.stakeFloor ?? "0"),
      stakeBasisPoints: Number(pre.stakeBasisPoints ?? "0"),
      fundingDeadline: BigInt(pre.recommendedFundingDeadline ?? Math.floor(Date.now() / 1000) + 30 * 86400),
      noSolutionGracePeriod: BigInt(pre.noSolutionGracePeriod ?? "86400"),
      token: pre.token.contractAddress as Address, amount: amountWei, feeAmount: 0n,
      feeShareBps: fees.feeShareBps,
      feeShares: [{ recipient: fees.platformFeeRecipient, basisPoints: 10000 }],
      walletClient: wc, privateKey: authed.wallet.privateKey as Hex,
    });
    await awaitReceipt(publicClient, result.txHash!);
  }

  private attackHeld(a: AttackScenario, observed: string): AttackResult {
    ok(`${a.id} defense held: ${observed}`);
    return {
      scenarioId: a.id,
      attack: a.attack,
      expectedDefenseLayer: a.expected_defense_layer,
      defenseHeld: true,
      observed,
    };
  }
  private attackFailed(a: AttackScenario, observed: string): AttackResult {
    fail(`${a.id} defense FAILED: ${observed}`);
    return {
      scenarioId: a.id,
      attack: a.attack,
      expectedDefenseLayer: a.expected_defense_layer,
      defenseHeld: false,
      observed,
    };
  }
}

// ── main ─────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const yamlPath = path.resolve(
    process.env.RT_BATTLE_FILE ?? "scripts/battle-scenarios.yaml",
  );
  if (!fs.existsSync(yamlPath)) {
    console.error(`battle-scenarios.yaml not found at ${yamlPath}`);
    return 2;
  }
  const cfg = parseYaml(fs.readFileSync(yamlPath, "utf-8")) as BattleConfig;

  const runner = new BattleRunner(cfg);
  const audit = await runner.run();

  const reportPath = path.resolve(
    process.env.RT_BATTLE_REPORT ?? "scripts/battle-report.json",
  );
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      audit,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  log("report", c.bold(reportPath));
  console.log("");
  console.log(c.bold("── Battle summary ──"));
  console.log(`  scenarios run: ${audit.scenariosRun}`);
  console.log(`  per-question conservation: ${audit.perQuestion.filter((p) => p.conserves).length}/${audit.perQuestion.length}`);
  console.log(`  chain total drift: ${fmtUsdc6(audit.chainTotalDriftWei)} USDC`);
  console.log(`  sybil findings: ${audit.sybilFindings.length}`);
  console.log(`  attack defenses: ${audit.attackVectors.filter((a) => a.defenseHeld).length}/${audit.attackVectors.length} held`);
  for (const a of audit.attackVectors) {
    console.log(`    ${a.defenseHeld ? c.green("✓") : c.red("✗")} ${a.scenarioId}: ${a.observed}`);
  }
  return audit.conservedOverall ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`\n${c.red("[FAIL]")} ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
