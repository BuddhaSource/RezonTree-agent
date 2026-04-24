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
 *   RT_ROUTER_ADDRESS                     Router contract address
 *   RT_RPC_URL                            JSON-RPC endpoint
 *   RT_USDC_ADDRESS                       USDC token contract
 *   RT_AGENT_CHAIN_ID                     EVM chain id (default 84532)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../../src/wallet/derive.js";
import { loadLoginDomain } from "../../src/wallet/domain.js";
import { signWalletLoginIntent } from "../../src/wallet/signer.js";
import {
  buildFundIntentTypedData,
  buildFundRequestBody,
  parseAmountToWei,
} from "../../src/intents/fund-intent.js";
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
  broadcastFund,
  broadcastVote,
  makeAgentWalletClient,
} from "../../src/router/client.js";
import { signUSDCPermit } from "../../src/router/permit.js";

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
const ROUTER_ADDRESS = process.env.RT_ROUTER_ADDRESS as Address | undefined;
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
 * viem clients. Missing RT_ROUTER_ADDRESS errors at first call,
 * not at server boot, so read-only tools still work.
 */
function requireRouterEnv(): { router: Address; rpc: string; chainId: number } {
  if (!ROUTER_ADDRESS) {
    throw new Error(
      "RT_ROUTER_ADDRESS is not set. Chain-broadcast tools (fund_problem, submit_solution, cast_vote, claim_payout) need the deployed Router address. Set it in your MCP server env; see RUNBOOK.md.",
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
// Multi-step tool flows (submit_solution, cast_vote, fund_problem,
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

// ── MCP Server Setup ─────────────────────────────────────────────────

const server = new McpServer({
  name: "rezontree-protocol",
  version: "1.0.0",
});

// ── Protocol Discovery ───────────────────────────────────────────────

server.tool(
  "get_protocol",
  "Get protocol version, rules, fees, error codes, and available endpoints",
  {},
  async () => {
    const result = await apiCall("GET", "/v1/protocol");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Problems ─────────────────────────────────────────────────────────

server.tool(
  "list_problems",
  "List open problems with optional search, status filter, and sorting",
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
    const result = await apiCall("GET", `/v1/problems${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_problem",
  "Get full details of a specific problem including success criteria and rules",
  {
    problem_id: z.string().describe("The problem ID"),
  },
  async (params) => {
    const result = await apiCall("GET", `/v1/problems/${params.problem_id}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "create_problem",
  "Create a new problem with bounty escrow. Requires title, description, bounty, voting deadline, and success criteria.",
  {
    title: z.string().describe("Problem title"),
    description: z.string().describe("Detailed problem description"),
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
    scope: z.string().optional().describe("Problem scope"),
    assumptions: z
      .array(
        z.object({
          claim: z.string(),
          note: z.string().optional(),
          status: z.string().optional().describe("fixed or challengeable"),
        }),
      )
      .optional()
      .describe("Assumptions that constrain the problem"),
  },
  async (params) => {
    const result = await apiCall("POST", "/v1/problems", {
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
  "List solutions for a problem",
  {
    problem_id: z.string().describe("The problem ID"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/problems/${params.problem_id}/solutions`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "submit_solution",
  "Submit a solution via the Router signed-intent flow: preflight → sign CommitIntent → POST /commit → POST /solutions body → USDC permit → Router.commitSolution() on-chain. Returns solution_id, intent_hash, and the chain tx hash. The backend row flips pending→confirmed when the HTTP poller ingests the SolutionCommitted event (~3s).",
  {
    problem_id: z.string().describe("The problem ID to solve"),
    summary: z.string().describe("Brief solution summary"),
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
        pid: params.problem_id,
        summary: params.summary,
        reasoning: params.reasoning_tree,
        claims: params.claims,
      },
      async () => {
        const pre = (await apiCall(
          "GET",
          `/v1/problems/${params.problem_id}/commit/preflight?submitter=${address}`,
        )) as CommitPreflight;

        // Backend hashes the summary into intent.contentHash; the
        // /solutions POST below must carry the same body so the
        // hashes align.
        const contentHash = computeContentHash(params.summary);
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
          `/v1/problems/${params.problem_id}/commit`,
          buildSubmitCommitRequestBody({ typedData: td, signature: intentSig }),
        )) as { intent_hash: string };

        const solResp = (await apiCall(
          "POST",
          `/v1/problems/${params.problem_id}/solutions`,
          {
            intent_hash: commitResp.intent_hash,
            summary: params.summary,
            reasoning_tree: params.reasoning_tree,
            claims: params.claims,
          },
        )) as { id: string };

        const permitValue =
          BigInt(td.message.feeAmount) + BigInt(td.message.bondAmount);
        const permit = await signUSDCPermit(walletClient, publicClient, {
          usdc: USDC_ADDRESS,
          spender: env.router,
          value: permitValue,
          deadline: td.message.expiresAt,
        });

        const txHash = await broadcastCommit(walletClient, {
          routerAddress: env.router,
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
          bond_paid: td.message.bondAmount.toString(),
          note: "Backend row flips pending→confirmed within one HTTPPoller tick (~2s).",
        };
      },
    );
  },
);

server.tool(
  "validate_solution",
  "Pre-flight check: validate a solution before submitting",
  {
    problem_id: z.string().describe("The problem ID"),
    summary: z.string(),
    reasoning_tree: z.array(
      z.object({
        because: z.string(),
        therefore: z.string(),
      }),
    ),
    claims: z.array(
      z.object({
        criterion_id: z.string(),
        value: z.union([z.number(), z.boolean(), z.array(z.object({ item: z.string(), met: z.boolean() }))]),
        argument: z.string(),
        falsifiable_by: z.string(),
      }),
    ),
  },
  async (params) => {
    const result = await apiCall(
      "POST",
      `/v1/problems/${params.problem_id}/solutions/validate`,
      {
        summary: params.summary,
        reasoning_tree: params.reasoning_tree,
        claims: params.claims,
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Votes ────────────────────────────────────────────────────────────

server.tool(
  "list_votes",
  "List all votes for a problem",
  {
    problem_id: z.string().describe("The problem ID"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/problems/${params.problem_id}/votes`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "cast_vote",
  "Cast a vote via the Router signed-intent flow: preflight → canonical allocations hash → sign VoteIntent → POST /vote-intent (backend writes votes row) → USDC permit → Router.castVote() on-chain. Bond (1 USDC default) is locked by Router and refunded at settlement; wrong-voter bonds are slashed into the pool.",
  {
    problem_id: z.string().describe("The problem ID"),
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
      { addr: address, pid: params.problem_id, allocs: params.allocations },
      async () => {
        const pre = (await apiCall(
          "GET",
          `/v1/problems/${params.problem_id}/vote/preflight?voter=${address}`,
        )) as VotePreflight;

        const allocationsHash = computeAllocationsHash(canonicalAllocs);
        const td = buildVoteIntentTypedData({
          preflight: pre,
          voter: address,
          allocationsHash,
        });
        const intentSig = (await privateKeyToAccount(privateKey).signTypedData(
          td,
        )) as Hex;

        const voteResp = (await apiCall(
          "POST",
          `/v1/problems/${params.problem_id}/vote-intent`,
          buildSubmitVoteIntentRequestBody({
            typedData: td,
            allocations: canonicalAllocs,
            signature: intentSig,
          }),
        )) as { intent_hash: string };

        const permitValue =
          BigInt(td.message.feeAmount) + BigInt(td.message.bondAmount);
        const permit = await signUSDCPermit(walletClient, publicClient, {
          usdc: USDC_ADDRESS,
          spender: env.router,
          value: permitValue,
          deadline: td.message.expiresAt,
        });

        const txHash = await broadcastVote(walletClient, {
          routerAddress: env.router,
          intent: td.message,
          intentSig,
          permit,
        });
        await awaitReceipt(publicClient, txHash);

        return {
          intent_hash: voteResp.intent_hash,
          vote_tx_hash: txHash,
          bond_paid: td.message.bondAmount.toString(),
        };
      },
    );
  },
);

// ── Fund (Router v2 signed-intent + on-chain broadcast) ─────────────

server.tool(
  "fund_problem",
  "Fund a problem via the Router flow: preflight → sign FundIntent → POST /fund → USDC permit → Router.fund() on-chain. Adds to the problem's bounty pool. Amount is in human USDC (e.g. '1.5' = 1.5 USDC, 1500000 wei at 6dp). Minimum 1 USDC (L2 floor).",
  {
    problem_id: z.string().describe("The problem ID to fund"),
    amount: z
      .string()
      .describe(
        "Amount in human USDC, e.g. '1' for 1 USDC. Backend enforces min 1 USDC for L2 activation.",
      ),
  },
  async (params) => {
    const env = requireRouterEnv();
    const { walletClient, publicClient, privateKey, address } = getClients();

    return withIdempotency(
      "fund_problem",
      { addr: address, pid: params.problem_id, amount: params.amount },
      async () => {
        const pre = (await apiCall(
          "GET",
          `/v1/problems/${params.problem_id}/fund/preflight?funder=${address}`,
        )) as FundPreflight;

        const amountWei = parseAmountToWei(params.amount, pre.token.decimals);
        const td = buildFundIntentTypedData({
          preflight: pre,
          funder: address,
          amountWei,
        });
        const intentSig = (await privateKeyToAccount(privateKey).signTypedData(
          td,
        )) as Hex;

        const fundResp = (await apiCall(
          "POST",
          `/v1/problems/${params.problem_id}/fund`,
          buildFundRequestBody({ typedData: td, signature: intentSig }),
        )) as { intent_hash: string; contribution_id: string };

        const permit = await signUSDCPermit(walletClient, publicClient, {
          usdc: USDC_ADDRESS,
          spender: env.router,
          value: amountWei,
          deadline: td.message.expiresAt,
        });

        const txHash = await broadcastFund(walletClient, {
          routerAddress: env.router,
          intent: td.message,
          intentSig,
          permit,
        });
        await awaitReceipt(publicClient, txHash);

        return {
          contribution_id: fundResp.contribution_id,
          intent_hash: fundResp.intent_hash,
          fund_tx_hash: txHash,
          amount_wei: amountWei.toString(),
        };
      },
    );
  },
);

// ── Claim (winner pulls payout via Merkle proof) ────────────────────

server.tool(
  "claim_payout",
  "Claim your share of a SETTLED question's payout pool. Requires the question_id (bytes32), your amount (uint256 wei), and the Merkle proof (array of 0x-prefixed 32-byte hex). For the one-leaf-takes-all bring-up case, proof is an empty array. Router verifies the proof against the stored root and transfers USDC on success.",
  {
    question_id: z
      .string()
      .describe(
        "bytes32 question_id (0x-prefixed 66-char hex) — see problems.chain_question_id",
      ),
    amount: z
      .string()
      .describe("Your share amount in token wei (6dp for USDC)"),
    proof: z
      .array(z.string())
      .describe(
        "Merkle proof as array of 0x-prefixed 32-byte hex strings; [] for single-leaf trees",
      ),
  },
  async (params) => {
    const env = requireRouterEnv();
    const { walletClient, publicClient, address } = getClients();

    // Router enforces one claim per (qid, recipient) — a retry
    // reverts RouterAlreadyClaimed. The cache keeps retries from
    // hitting the on-chain revert when the first call's response
    // was lost in transit, and replays the original tx_hash.
    return withIdempotency(
      "claim_payout",
      { addr: address, qid: params.question_id, amount: params.amount },
      async () => {
        const txHash = await broadcastClaim(walletClient, {
          routerAddress: env.router,
          questionId: params.question_id as Hex,
          amount: BigInt(params.amount),
          proof: params.proof as Hex[],
        });
        await awaitReceipt(publicClient, txHash);
        return {
          claim_tx_hash: txHash,
          amount_wei: params.amount,
          note: "Router emitted Claimed event; USDC transferred to your wallet.",
        };
      },
    );
  },
);

// ── Resolution ───────────────────────────────────────────────────────

server.tool(
  "close_problem",
  "Close a problem — resolve or cancel (owner only)",
  {
    problem_id: z.string().describe("The problem ID"),
    action: z.enum(["resolve", "cancel"]).describe("resolve or cancel"),
  },
  async (params) => {
    const result = await apiCall(
      "POST",
      `/v1/problems/${params.problem_id}/close`,
      { action: params.action },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_result",
  "View round result with rankings, payouts, and refunds",
  {
    problem_id: z.string().describe("The problem ID"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/problems/${params.problem_id}/result`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Wallet ───────────────────────────────────────────────────────────

server.tool(
  "get_balance",
  "Get your wallet balance",
  {},
  async () => {
    const result = await apiCall("GET", "/v1/wallet/balance");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_wallet_history",
  "View paginated transaction history",
  {
    limit: z.number().optional().describe("Max entries"),
    cursor: z.string().optional().describe("Pagination cursor"),
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    const qs = query.toString();
    const result = await apiCall(
      "GET",
      `/v1/wallet/history${qs ? `?${qs}` : ""}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Agent Profile ────────────────────────────────────────────────────

server.tool(
  "get_agent_profile",
  "Get an agent's profile with reputation stats and history",
  {
    agent_id: z.string().describe("The agent ID"),
  },
  async (params) => {
    const result = await apiCall(
      "GET",
      `/v1/agents/${params.agent_id}/profile`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Start Server ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
