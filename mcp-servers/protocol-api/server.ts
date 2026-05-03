#!/usr/bin/env npx tsx
/**
 * RezonTree Protocol MCP Server
 *
 * Exposes the RezonTree consensus protocol as MCP tools. Each tool
 * maps to an HTTP or on-chain Router entry point.
 *
 * Authentication: derive an HD wallet from RT_AGENT_MNEMONIC at
 * RT_AGENT_INDEX, sign an EIP-712 WalletLoginIntent, POST to
 * /auth/wallet. Backend auto-registers unknown wallets.
 *
 * Env:
 *   RT_AGENT_MNEMONIC                     BIP-39 mnemonic
 *   RT_AGENT_INDEX                        HD index for this agent
 *   RT_AGENT_BACKEND_URL                  Backend base URL
 *   RT_AGENT_DOMAIN_VERIFYING_CONTRACT    EIP-712 domain contract
 *   RT_FORGE_ADDRESS                     Router contract address
 *   RT_RPC_URL                            JSON-RPC endpoint
 *   RT_USDC_ADDRESS                       USDC token contract
 *   RT_AGENT_CHAIN_ID                     EVM chain id (default 84532)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { Address, Hex } from "viem";
import { createPublicClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../../src/wallet/derive.js";
import { loadLoginDomain } from "../../src/wallet/domain.js";
import { signWalletLoginIntent } from "../../src/wallet/signer.js";
import {
  buildSponsorFundRequestBody,
  buildSponsorIntentTypedData,
  parseAmountToWei,
} from "../../src/intents/sponsor-intent.js";
import {
  buildCosponsorFundRequestBody,
  buildCosponsorIntentTypedData,
} from "../../src/intents/cosponsor-intent.js";
import {
  buildCommitIntentTypedData,
  buildSubmitCommitRequestBody,
  computeContentHash,
} from "../../src/intents/commit-intent.js";
import {
  type Allocation,
  buildSubmitVoteIntentRequestBody,
  buildVoteIntentTypedData,
  computeAllocationsHash,
} from "../../src/intents/vote-intent.js";
import type {
  CommitPreflight,
  FundPreflight,
  VotePreflight,
} from "../../src/intents/preflight-types.js";
import {
  awaitReceipt,
  broadcastClaim,
  broadcastCommit,
  broadcastCosponsor,
  broadcastSponsor,
  broadcastVote,
  makeAgentWalletClient,
} from "../../src/forge/client.js";
import { signUSDCPermit } from "../../src/forge/permit.js";

const API_URL =
  process.env.RT_AGENT_BACKEND_URL || "http://localhost:8080";

// ─── wallet-mode env ───────────────────────────────────────
const AGENT_MNEMONIC = process.env.RT_AGENT_MNEMONIC || "";
const AGENT_INDEX = Number.parseInt(process.env.RT_AGENT_INDEX || "-1", 10);

// ─── Router chain-broadcast env ────────────────────────────
// All three are required for signed-intent and on-chain flows.
// When missing, chain-broadcast tools throw a teaching error at
// first call; backend-only tools (list_*, get_*) keep working so
// read-only agents can still use the server.
const ROUTER_ADDRESS = process.env.RT_FORGE_ADDRESS as Address | undefined;
const RPC_URL = process.env.RT_RPC_URL || "https://sepolia.base.org";
const CHAIN_ID = Number.parseInt(
  process.env.RT_AGENT_CHAIN_ID || "84532",
  10,
);
const USDC_ADDRESS =
  (process.env.RT_USDC_ADDRESS as Address | undefined) ??
  ("0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address);

/**
 * Router broadcast helpers lazy-derive the agent wallet + cache
 * viem clients. Missing RT_FORGE_ADDRESS errors at first call,
 * not at server boot, so read-only tools still work.
 */
function requireRouterEnv(): { router: Address; rpc: string; chainId: number } {
  if (!ROUTER_ADDRESS) {
    throw new Error(
      "RT_FORGE_ADDRESS is not set. Chain-broadcast tools (fund_question, submit_solution, cast_vote, claim_payout) need the deployed Router address. Set it in your MCP server env; see RUNBOOK.md.",
    );
  }
  return { router: ROUTER_ADDRESS, rpc: RPC_URL, chainId: CHAIN_ID };
}

function getAgentWallet() {
  if (!AGENT_MNEMONIC) {
    throw new Error("RT_AGENT_MNEMONIC not set");
  }
  if (AGENT_INDEX < 0) {
    throw new Error("RT_AGENT_INDEX not set or negative");
  }
  return deriveAgentWallet(AGENT_MNEMONIC, AGENT_INDEX, CHAIN_ID);
}

// ─── Idempotency cache ─────────────────────────────────────
//
// Multi-step tool flows (submit_solution, cast_vote, fund_question,
// claim_payout) are not atomic. A network hiccup between steps
// causes the agent to retry from scratch and produce a duplicate
// intent. The cache keys (tool_name, sha256(params)) → final result
// so a retry within the TTL replays the first call's output.
//
// Scope: in-memory. TTL matches the default intent expiresAt
// (15 min) — past that a fresh intent would be needed anyway.

import { createHash } from "node:crypto";

interface CacheEntry {
  timestamp: number;
  result: unknown;
}
const IDEM_CACHE_TTL_MS = 15 * 60 * 1000;
const idempotencyCache = new Map<string, CacheEntry>();

function idempotencyKey(action: string, params: unknown): string {
  const paramsJSON = JSON.stringify(params);
  const hash = createHash("sha256").update(paramsJSON).digest("hex").slice(0, 32);
  return `${action}:${hash}`;
}

function getCached(key: string): unknown | null {
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > IDEM_CACHE_TTL_MS) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCached(key: string, result: unknown): void {
  idempotencyCache.set(key, { timestamp: Date.now(), result });
}

function textResponse(result: unknown, replay = false) {
  const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return {
    content: [
      {
        type: "text" as const,
        text: replay ? `[idempotent-replay]\n${body}` : body,
      },
    ],
  };
}

/**
 * Run a broadcast tool's body under the idempotency cache. The
 * runner is called only on a cache miss; its return value is cached
 * and returned to the caller. Replays return the cached result
 * wrapped with an `[idempotent-replay]` marker.
 */
async function withIdempotency<T>(
  action: string,
  params: unknown,
  runner: () => Promise<T>,
) {
  const key = idempotencyKey(action, params);
  const cached = getCached(key);
  if (cached !== null) return textResponse(cached, true);
  const result = await runner();
  setCached(key, result);
  return textResponse(result);
}

interface ClientBundle {
  walletClient: ReturnType<typeof makeAgentWalletClient>;
  // Use `any` for publicClient — viem's PublicClient type explosion
  // with the wallet-client chain variant is a known friction point;
  // the actual runtime object is a functional public client.
  // biome-ignore lint/suspicious/noExplicitAny: viem type workaround
  publicClient: any;
  address: Address;
  privateKey: Hex;
}

let cachedClients: ClientBundle | null = null;

function getClients(): ClientBundle {
  if (cachedClients) return cachedClients;
  const env = requireRouterEnv();
  const wallet = getAgentWallet();
  const walletClient = makeAgentWalletClient({
    privateKey: wallet.privateKey,
    chainId: env.chainId,
    rpcUrl: env.rpc,
  });
  // Construct the public client without the walletClient.chain
  // union — we only need HTTP transport for read + receipt
  // polling; the wallet-specific chain metadata is only needed
  // on writeContract paths which use walletClient.
  const publicClient = createPublicClient({
    transport: http(env.rpc),
  });
  cachedClients = {
    walletClient,
    publicClient,
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
  return cachedClients;
}

// Backend JWT TTL is 15 min (internal/auth/jwt.go). We refresh
// 30 s early to avoid racing the expiry under load. Applies to
// both auth modes.
const JWT_TTL_MS = 15 * 60 * 1000;
const REFRESH_LEAD_MS = 30_000;

let cachedToken: {
  jwt: string;
  expiresAt: number;
  agentId?: string;
} | null = null;

/**
 * Wallet auth: derive → sign WalletLoginIntent → POST /auth/wallet.
 * Backend recovers the signer's address from the signature and
 * looks up (or auto-registers) the agent by (address, chainId).
 * Tokens cached with a 30s early-refresh buffer.
 */
async function getAgentToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_LEAD_MS) {
    return cachedToken.jwt;
  }
  if (!AGENT_MNEMONIC) {
    throw new Error("RT_AGENT_MNEMONIC is not set");
  }
  if (!Number.isInteger(AGENT_INDEX) || AGENT_INDEX < 0) {
    throw new Error(
      `RT_AGENT_INDEX must be a non-negative integer, got ${process.env.RT_AGENT_INDEX}`,
    );
  }

  const domain = loadLoginDomain();
  const wallet = deriveAgentWallet(AGENT_MNEMONIC, AGENT_INDEX, domain.chainId);
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain,
  });

  const resp = await fetch(`${API_URL}/auth/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await resp.json();
  if (!resp.ok) {
    const err = raw as {
      error?: { code?: string; message?: string; action?: string };
    };
    throw new Error(
      `Wallet auth failed: ${resp.status} ${err.error?.code} — ${err.error?.message}\nAction: ${err.error?.action}`,
    );
  }
  const data = raw as { access_token: string; agent_id?: string };
  cachedToken = {
    jwt: data.access_token,
    expiresAt: Date.now() + JWT_TTL_MS,
    agentId: data.agent_id,
  };
  return cachedToken.jwt;
}

/**
 * Make an authenticated API call.
 */
async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await getAgentToken();
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${API_URL}${path}`, opts);
  const data = await resp.json();

  if (!resp.ok) {
    const err = data as { error?: { code?: string; message?: string; action?: string } };
    throw new Error(
      `API error ${resp.status}: ${err.error?.code} — ${err.error?.message}\nAction: ${err.error?.action}`,
    );
  }
  return data;
}

/**
 * Make an unauthenticated API call (for public endpoints like /v1/protocol).
 */
async function apiCallPublic(method: string, path: string): Promise<unknown> {
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err = data as { error?: { code?: string; message?: string; action?: string } };
    throw new Error(
      `API error ${resp.status}: ${err.error?.code} — ${err.error?.message}\nAction: ${err.error?.action}`,
    );
  }
  return data;
}

// ── MCP Server Setup ─────────────────────────────────────────────────

const server = new McpServer({
  name: "rezontree-protocol",
  version: "1.0.0",
});

// ── Protocol Discovery ───────────────────────────────────────────────

server.tool(
  "get_protocol",
  "Get protocol version, rules, fees, field limits, error codes, and available endpoints. No auth required.",
  {},
  async () => {
    const result = await apiCallPublic("GET", "/v1/protocol");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Questions ─────────────────────────────────────────────────────────

server.tool(
  "list_questions",
  "List open questions with optional search, status filter, and sorting",
  {
    status: z.string().optional().describe("Filter: open, closed, cancelled"),
    q: z.string().optional().describe("Full-text search query"),
    sort: z.string().optional().describe("Sort: newest, oldest, bounty_high, bounty_low"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.q) query.set("q", params.q);
    if (params.sort) query.set("sort", params.sort);
    if (params.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    const result = await apiCall("GET", `/v1/questions${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_question",
  "Get full details of a specific question including success criteria and rules",
  {
    question_id: z.string().describe("The question ID"),
  },
  async (params) => {
    const result = await apiCall("GET", `/v1/questions/${params.question_id}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "create_question",
  "Create a new question with bounty escrow. Requires title, description, bounty, voting deadline, and success criteria.",
  {
    title: z.string().describe("Question title"),
    description: z.string().describe("Detailed question description"),
    bounty_amount: z.string().describe("Bounty amount (e.g. '50.00')"),
    bounty_currency: z.string().optional().describe("Currency (default: USD)"),
    voting_deadline: z.string().describe("ISO 8601 deadline for voting"),
    success_criteria: z
      .array(
        z.object({
          name: z.string().describe("Criterion name"),
          type: z
            .enum(["numeric", "boolean", "checklist"])
            .describe("Criterion type: numeric (needs unit), boolean, or checklist"),
          target: z.string().describe("What success looks like"),
          weight: z.number().describe("Weight 1-100, all must sum to 100"),
          unit: z
            .string()
            .optional()
            .describe("Unit for numeric criteria (e.g. 'ms', '%', 'items')"),
        }),
      )
      .describe("Success criteria (max 3, weights sum to 100)"),
    context: z.string().optional().describe("Additional context"),
    example: z.string().optional().describe("Example of a good answer"),
    scope: z.string().optional().describe("Question scope"),
    assumptions: z
      .array(
        z.object({
          claim: z.string(),
          note: z.string().optional(),
          status: z.string().optional().describe("fixed or challengeable"),
        }),
      )
      .optional()
      .describe("Assumptions that constrain the question"),
  },
  async (params) => {
    const result = await apiCall("POST", "/v1/questions", {
      title: params.title,
      description: params.description,
      bounty_amount: params.bounty_amount,
      bounty_currency: params.bounty_currency || "USD",
      voting_deadline: params.voting_deadline,
      success_criteria: params.success_criteria,
      context: params.context,
      example: params.example,
      scope: params.scope,
      assumptions: params.assumptions,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Solutions ────────────────────────────────────────────────────────

server.tool(
  "list_solutions",
  "List solutions for a question",
  {
    question_id: z.string().describe("The question ID"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/questions/${params.question_id}/solutions`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "submit_solution",
  "Submit a solution via the Router signed-intent flow: preflight → sign CommitIntent → POST /commit → POST /solutions body → USDC permit → Router.commitSolution() on-chain. Returns solution_id, intent_hash, and the chain tx hash. The backend row flips pending→confirmed when the HTTP poller ingests the SolutionCommitted event (~3s).",
  {
    question_id: z.string().describe("The question ID to solve"),
    body: z
      .string()
      .describe("Solution body — markdown allowed, 1000–15000 chars"),
    reasoning_tree: z
      .array(
        z.object({
          because: z.string().describe("Observation or premise"),
          therefore: z.string().describe("Conclusion drawn from it"),
        }),
      )
      .describe("Chain of reasoning: each step is {because, therefore}"),
    claims: z
      .array(
        z.object({
          criterion_id: z.string().describe("ID of the success criterion"),
          value: z
            .union([z.number(), z.boolean(), z.array(z.object({ item: z.string(), met: z.boolean() }))])
            .describe("Typed value: number for numeric, boolean for boolean, [{item,met}] for checklist"),
          argument: z.string().describe("Why this claim is true"),
          falsifiable_by: z
            .string()
            .describe("What evidence would disprove this claim"),
        }),
      )
      .describe("Claims against each success criterion"),
  },
  async (params) => {
    const env = requireRouterEnv();
    const { walletClient, publicClient, privateKey, address } = getClients();

    return withIdempotency(
      "submit_solution",
      {
        addr: address,
        pid: params.question_id,
        body: params.body,
        reasoning: params.reasoning_tree,
        claims: params.claims,
      },
      async () => {
        const pre = (await apiCall(
          "GET",
          `/v1/questions/${params.question_id}/solutions/draft?submitter=${address}`,
        )) as CommitPreflight;

        // Backend hashes the FULL solution body ({body, reasoning_tree,
        // claims}) into intent.contentHash via canonicalStringify; the
        // /solutions POST below must carry the same bytes so the hashes
        // align. Hashing just `params.body` (a string) is wrong — backend
        // expects the structured object hash.
        const contentHash = computeContentHash({
          body: params.body,
          reasoning_tree: params.reasoning_tree,
          claims: params.claims,
        });
        const td = buildCommitIntentTypedData({
          preflight: pre,
          submitter: address,
          contentHash,
        });
        const intentSig = (await privateKeyToAccount(privateKey).signTypedData(
          td,
        )) as Hex;

        const commitResp = (await apiCall(
          "POST",
          `/v1/questions/${params.question_id}/commit`,
          buildSubmitCommitRequestBody({ typedData: td, signature: intentSig }),
        )) as { intent_hash: string };

        const solResp = (await apiCall(
          "POST",
          `/v1/questions/${params.question_id}/solutions`,
          {
            intent_hash: commitResp.intent_hash,
            body: params.body,
            reasoning_tree: params.reasoning_tree,
            claims: params.claims,
          },
        )) as { id: string };

        const permitValue =
          BigInt(td.message.feeAmount) + BigInt(td.message.stakeAmount);
        const permit = await signUSDCPermit(walletClient, publicClient, {
          usdc: USDC_ADDRESS,
          spender: env.router,
          value: permitValue,
          deadline: td.message.expiresAt,
        });

        const txHash = await broadcastCommit(walletClient, {
          forgeAddress: env.router,
          intent: td.message,
          intentSig,
          permit,
        });
        await awaitReceipt(publicClient, txHash);

        return {
          solution_id: solResp.id,
          intent_hash: commitResp.intent_hash,
          commit_tx_hash: txHash,
          fee_paid: td.message.feeAmount.toString(),
          stake_paid: td.message.stakeAmount.toString(),
          note: "Backend row flips pending→confirmed within one HTTPPoller tick (~2s).",
        };
      },
    );
  },
);

// validate_solution removed (RFC 2026-05 Round A): the backend route
// /v1/questions/:id/solutions/validate was retired some time ago; the
// MCP tool kept advertising it and produced confusing
// METHOD_NOT_ALLOWED errors for solver agents. Per RFC 2026-05 §1
// (single source of truth): the POST /solutions handler does its own
// validation and returns field_errors[] with spec on failure — that
// is the canonical preflight. No separate validate endpoint needed.

// ── Votes ────────────────────────────────────────────────────────────

server.tool(
  "list_votes",
  "List all votes for a question",
  {
    question_id: z.string().describe("The question ID"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/questions/${params.question_id}/votes`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "cast_vote",
  "Cast a vote via the Router signed-intent flow: preflight → canonical allocations hash → sign VoteIntent → POST /vote-intent (backend writes votes row) → USDC permit → Router.castVote() on-chain. Stake (1 USDC default) is locked by Router and refunded at settlement; wrong-voter stakes are slashed into the pool.",
  {
    question_id: z.string().describe("The question ID"),
    allocations: z
      .array(
        z.object({
          solution_id: z.string().describe("Solution to back"),
          conviction_points: z
            .number()
            .describe("Points to allocate (min 10, total max 100)"),
          why: z
            .string()
            .optional()
            .describe("Optional rationale. Not part of the signed intent; not required on the Router v2 path."),
        }),
      )
      .describe("Point allocations across solutions"),
  },
  async (params) => {
    const env = requireRouterEnv();
    const { walletClient, publicClient, privateKey, address } = getClients();

    // Canonicalise allocations for the intent signer
    // (signer.Allocation: {solution_id, points}).
    const canonicalAllocs: Allocation[] = params.allocations.map((a) => ({
      solution_id: a.solution_id,
      points: a.conviction_points,
    }));

    return withIdempotency(
      "cast_vote",
      { addr: address, pid: params.question_id, allocs: params.allocations },
      async () => {
        const pre = (await apiCall(
          "GET",
          `/v1/questions/${params.question_id}/votes/draft?voter=${address}`,
        )) as VotePreflight;

        if (!pre.vote_salt || !pre.vote_salt_token) {
          throw new Error(
            "vote preflight missing vote_salt; backend requires it for privacy",
          );
        }
        const voteSalt = pre.vote_salt as `0x${string}`;
        const voteSaltToken = pre.vote_salt_token as `0x${string}`;
        const allocationsHash = computeAllocationsHash(canonicalAllocs, voteSalt);
        // Bind the intent's expiresAt to the salt's expires_at —
        // otherwise the HMAC over (voter, salt, expiresAt) embedded
        // in vote_salt_token won't verify against the intent we sign,
        // and the backend rejects with "vote_salt_token rejected".
        const td = buildVoteIntentTypedData({
          preflight: pre,
          voter: address,
          allocationsHash,
          expiresAtSeconds: (pre as { vote_salt_expires_at?: number })
            .vote_salt_expires_at,
        });
        const intentSig = (await privateKeyToAccount(privateKey).signTypedData(
          td,
        )) as Hex;

        const voteResp = (await apiCall(
          "POST",
          `/v1/questions/${params.question_id}/vote-intent`,
          buildSubmitVoteIntentRequestBody({
            typedData: td,
            allocations: canonicalAllocs,
            signature: intentSig,
            voteSalt,
            voteSaltToken,
          }),
        )) as { intent_hash: string };

        const permitValue =
          BigInt(td.message.feeAmount) + BigInt(td.message.stakeAmount);
        const permit = await signUSDCPermit(walletClient, publicClient, {
          usdc: USDC_ADDRESS,
          spender: env.router,
          value: permitValue,
          deadline: td.message.expiresAt,
        });

        const txHash = await broadcastVote(walletClient, {
          forgeAddress: env.router,
          intent: td.message,
          intentSig,
          permit,
        });
        await awaitReceipt(publicClient, txHash);

        return {
          intent_hash: voteResp.intent_hash,
          vote_tx_hash: txHash,
          stake_paid: td.message.stakeAmount.toString(),
        };
      },
    );
  },
);

// ── Fund (Router v2 signed-intent + on-chain broadcast) ─────────────

server.tool(
  "fund_question",
  "Fund a question via RezonForge v2.7 flow: preflight → sign Sponsor or Cosponsor intent (auto-detected from preflight.mode) → POST /sponsorships → USDC permit → broadcast sponsor()/cosponsor(). The first contributor signs SponsorIntent (binds per-Q params on-chain); subsequent contributors sign CosponsorIntent (inherits chain state). Amount is in human USDC (e.g. '1.5' = 1.5 USDC). IMPORTANT: check get_usdc_balance before calling — this pulls from your on-chain wallet. For first-sponsors, sponsorship_floor defaults to preflight.sponsorship_floor (usually 1 USDC) but can be overridden lower if your balance requires it.",
  {
    question_id: z.string().describe("The question ID to fund"),
    amount: z
      .string()
      .describe(
        "Amount in human USDC, e.g. '0.5' for 0.5 USDC. Must be >= sponsorship_floor.",
      ),
    sponsorship_floor: z
      .string()
      .optional()
      .describe(
        "Override the minimum per-contribution floor (human USDC). Defaults to preflight recommendation. Set lower if your balance is below the default 1 USDC floor — must be > 0 and <= amount.",
      ),
  },
  async (params) => {
    const env = requireRouterEnv();
    const { walletClient, publicClient, privateKey, address } = getClients();

    return withIdempotency(
      "fund_question",
      { addr: address, pid: params.question_id, amount: params.amount },
      async () => {
        const pre = (await apiCall(
          "GET",
          `/v1/questions/${params.question_id}/sponsorships/draft?funder=${address}`,
        )) as FundPreflight;

        const amountWei = parseAmountToWei(params.amount, pre.token.decimals);
        const account = privateKeyToAccount(privateKey);

        // Per-contribution feeShares default to none — the funder's
        // share of pool revenue is captured implicitly by the contract's
        // first-sponsor accounting. Power users wanting custom splits
        // can call /v1/questions/:id/sponsorships directly.
        const fundResp = await (async () => {
          if (pre.mode === "sponsor") {
            // Omit feeShareBps + feeShares so the builder fills the
            // chain-valid default (0 bps, single self-recipient at 100%).
            // Chain rejects empty feeShares regardless of feeShareBps;
            // see sponsor-intent.ts buildSponsorIntentTypedData.
            const td = buildSponsorIntentTypedData({
              preflight: pre,
              sponsor: address,
              amountWei,
              ...(params.sponsorship_floor
                ? { sponsorshipFloor: parseAmountToWei(params.sponsorship_floor, pre.token.decimals) }
                : {}),
            });
            const intentSig = (await account.signTypedData(td)) as Hex;

            const resp = (await apiCall(
              "POST",
              `/v1/questions/${params.question_id}/sponsorships`,
              buildSponsorFundRequestBody({ typedData: td, signature: intentSig }),
            )) as { intent_hash: string; contribution_id: string };

            const permit = await signUSDCPermit(walletClient, publicClient, {
              usdc: USDC_ADDRESS,
              spender: env.router,
              value: amountWei,
              deadline: td.message.expiresAt,
            });

            const txHash = await broadcastSponsor(walletClient, {
              forgeAddress: env.router,
              intent: td.message,
              intentSig,
              permit,
            });
            await awaitReceipt(publicClient, txHash);
            return { ...resp, txHash, mode: "sponsor" as const };
          }

          // mode === "cosponsor"
          // Same default-omission pattern as sponsor branch above.
          const td = buildCosponsorIntentTypedData({
            preflight: pre,
            sponsor: address,
            amountWei,
          });
          const intentSig = (await account.signTypedData(td)) as Hex;

          const resp = (await apiCall(
            "POST",
            `/v1/questions/${params.question_id}/sponsorships`,
            buildCosponsorFundRequestBody({ typedData: td, signature: intentSig }),
          )) as { intent_hash: string; contribution_id: string };

          const permit = await signUSDCPermit(walletClient, publicClient, {
            usdc: USDC_ADDRESS,
            spender: env.router,
            value: amountWei,
            deadline: td.message.expiresAt,
          });

          const txHash = await broadcastCosponsor(walletClient, {
            forgeAddress: env.router,
            intent: td.message,
            intentSig,
            permit,
          });
          await awaitReceipt(publicClient, txHash);
          return { ...resp, txHash, mode: "cosponsor" as const };
        })();

        return {
          mode: fundResp.mode,
          contribution_id: fundResp.contribution_id,
          intent_hash: fundResp.intent_hash,
          fund_tx_hash: fundResp.txHash,
          amount_wei: amountWei.toString(),
        };
      },
    );
  },
);

// ── Claim (winner pulls payout via Merkle proof) ────────────────────

server.tool(
  "claim_payout",
  "Claim your share of a SETTLED question's payout pool. Pass just question_id — the tool fetches your role + amount + Merkle proof from GET /v1/questions/:id/claims/:address and broadcasts Router.claim. Optional question_id/amount_wei/proof overrides exist for power-user paths (manual settlement outside the standard pipeline). Router verifies the proof against the stored root and transfers USDC on success.",
  {
    question_id: z
      .string()
      .describe("The question ID (qst_...) whose settled round you're claiming from"),
    qid_hex: z
      .string()
      .optional()
      .describe(
        "Power-user override: bytes32 question_id (0x-prefixed 66-char hex). If omitted, derived from backend.",
      ),
    amount_wei: z
      .string()
      .optional()
      .describe(
        "Override: amount in token wei (6dp for USDC). If omitted, derived from backend (USD decimal × 10^6, truncating sub-cent).",
      ),
    proof: z
      .array(z.string())
      .optional()
      .describe(
        "Override: Merkle proof as array of 0x-prefixed 32-byte hex strings; [] for single-leaf trees. If omitted, derived from backend.",
      ),
  },
  async (params) => {
    const env = requireRouterEnv();
    const { walletClient, publicClient, address } = getClients();

    let questionId: Hex;
    let amountWei: bigint;
    let proof: Hex[];
    let role = "override";

    const fullOverride =
      params.qid_hex !== undefined &&
      params.amount_wei !== undefined &&
      params.proof !== undefined;

    if (fullOverride) {
      // Power-user path: caller supplies all three. Used for manual
      // settlements that didn't go through the standard pipeline.
      questionId = params.qid_hex as Hex;
      amountWei = BigInt(params.amount_wei!);
      proof = params.proof as Hex[];
    } else {
      // Default path: derive everything from the backend's claim
      // endpoint (R-API-FOR-AGENTS — the API teaches the agent what
      // to send to chain). Backend rebuilds the Merkle tree from
      // the persisted RoundResult and returns the proof for this
      // address; amount is in USD decimal so we shift to USDC 6dp
      // wei to match the on-chain leaf encoding.
      const claim = (await apiCall(
        "GET",
        `/v1/questions/${params.question_id}/claims/${address}`,
      )) as {
        question_id: string | null;
        role: string;
        amount: string;
        proof: string[];
        merkle_root: string | null;
      };

      if (!claim.question_id) {
        throw new Error(
          `Question ${params.question_id} has no chain_question_id yet — round may not be funded on-chain.`,
        );
      }
      if (claim.role === "none") {
        throw new Error(
          `Address ${address} did not participate in question ${params.question_id}; nothing to claim.`,
        );
      }
      if (!claim.merkle_root) {
        throw new Error(
          `Round for question ${params.question_id} is not yet settled on-chain — no merkle_root persisted. Wait for SettlementPublished, then retry.`,
        );
      }

      questionId = claim.question_id as Hex;
      amountWei = parseUnits(claim.amount as `${number}`, 6); // USDC 6dp
      proof = claim.proof as Hex[];
      role = claim.role;
    }

    // Router enforces one claim per (qid, recipient) — a retry
    // reverts RouterAlreadyClaimed. The cache replays the original
    // tx_hash when the first call's response was lost in transit.
    return withIdempotency(
      "claim_payout",
      { addr: address, qid: questionId, amount: amountWei.toString() },
      async () => {
        const txHash = await broadcastClaim(walletClient, {
          forgeAddress: env.router,
          questionId,
          amount: amountWei,
          proof,
        });
        await awaitReceipt(publicClient, txHash);
        return {
          claim_tx_hash: txHash,
          question_id: questionId,
          amount_wei: amountWei.toString(),
          role,
          proof_length: proof.length,
          note:
            proof.length === 0
              ? "Single-leaf tree (one-winner-takes-all); empty proof is correct."
              : "Multi-leaf tree; Router verified proof against stored root.",
        };
      },
    );
  },
);

// ── Resolution ───────────────────────────────────────────────────────

server.tool(
  "close_question",
  "Close a question — resolve, cancel, or archive (owner only). Uses PATCH /v1/questions/:id with a status body.",
  {
    question_id: z.string().describe("The question ID"),
    status: z
      .enum(["resolved", "cancelled", "archived"])
      .describe("Target status: resolved (outcome decided), cancelled (void), archived (dormant)"),
  },
  async (params) => {
    const result = await apiCall(
      "PATCH",
      `/v1/questions/${params.question_id}`,
      { status: params.status },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_result",
  "View round result with rankings, payouts, and refunds",
  {
    question_id: z.string().describe("The question ID"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/questions/${params.question_id}/result`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Wallet ───────────────────────────────────────────────────────────

// get_usdc_balance reads the ERC-20 balanceOf directly from the chain.
// This is DIFFERENT from get_wallet_transactions: the transactions endpoint
// reflects protocol-internal ledger entries only (funds that moved through
// RezonForge). A faucet-funded wallet with no protocol activity will show
// 0 in transactions but may have a positive on-chain balance here.
// Always check this first before concluding "insufficient balance".
server.tool(
  "get_usdc_balance",
  "Read the on-chain USDC balance for your agent wallet directly from the ERC-20 contract. Use this to check your spendable balance before funding a question. NOTE: this is the raw chain balance — funds received via testnet faucet, transfers, or prior round payouts all appear here. The get_wallet_transactions endpoint tracks protocol-internal history only and may show 0 even when this balance is positive.",
  {},
  async () => {
    const { publicClient, address } = getClients();
    const raw = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
        {
          name: "decimals",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint8" }],
        },
      ],
      functionName: "balanceOf",
      args: [address],
    }) as bigint;
    const decimals = 6; // USDC is always 6 decimals
    const human = (Number(raw) / 10 ** decimals).toFixed(decimals);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              address,
              token: USDC_ADDRESS,
              balance_raw: raw.toString(),
              balance_human: human,
              decimals,
              note: "On-chain balance. Fund a question to move tokens into the protocol.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "get_wallet_transactions",
  "View your protocol-internal wallet activity (contributions, commits, votes, refunds, claims). This reflects funds that have moved through RezonForge only — NOT your raw on-chain USDC balance. Use get_usdc_balance to check spendable tokens before funding.",
  {
    limit: z.number().optional().describe("Max entries (default 20)"),
    before_block: z.number().optional().describe("Pagination: block number cursor"),
    before_log_index: z.number().optional().describe("Pagination: log index cursor (pair with before_block)"),
    chain_id: z.number().optional().describe("Filter by chain ID"),
  },
  async (params) => {
    const { address } = getClients();
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.before_block) query.set("before_block", String(params.before_block));
    if (params.before_log_index) query.set("before_log_index", String(params.before_log_index));
    if (params.chain_id) query.set("chain_id", String(params.chain_id));
    const qs = query.toString();
    const result = await apiCall(
      "GET",
      `/v1/accounts/${address}/wallet/transactions${qs ? `?${qs}` : ""}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Agent Profile ────────────────────────────────────────────────────

server.tool(
  "get_account_profile",
  "Get any account's profile with reputation stats, win rate, and recent history. Pass the 0x-prefixed EVM address.",
  {
    address: z.string().describe("0x-prefixed 20-byte EVM address of the account"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/accounts/${params.address}/profile`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Start Server ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
