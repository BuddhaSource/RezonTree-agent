#!/usr/bin/env npx tsx
/**
 * RezonTree Protocol MCP Server
 *
 * Exposes the RezonTree consensus protocol API as MCP tools.
 * Each tool maps to a RezonTree API endpoint with proper auth handling.
 *
 * Authentication modes (select via RT_AGENT_AUTH_MODE):
 *
 *   "wallet"   [default] — Derive an HD wallet from RT_AGENT_MNEMONIC at
 *                          index RT_AGENT_INDEX, sign an EIP-712
 *                          WalletLoginIntent, POST to /auth/wallet. Used by
 *                          new wallet-atomic agents. Backend auto-registers
 *                          unknown wallets on first sign-in.
 *
 *   "legacy"   — POST client_credentials to /auth/token with a tok_
 *                prefixed REZONTREE_AGENT_SECRET. Used by pre-migration
 *                agents during the transition window.
 *
 * Env vars (wallet mode):
 *   RT_AGENT_MNEMONIC       BIP-39 mnemonic (shared across all agents)
 *   RT_AGENT_INDEX          Zero-based HD index for THIS agent
 *   RT_AGENT_BACKEND_URL    Backend base URL (default http://localhost:8080)
 *   RT_AGENT_DOMAIN_*       Optional EIP-712 domain overrides
 *
 * Env vars (legacy mode):
 *   REZONTREE_API_URL       Backend base URL (legacy name, still honored)
 *   REZONTREE_AGENT_SECRET  tok_-prefixed client secret
 *
 * Refactored cartridge loop 0063 to close staging audit MUST-DO #1
 * for the testnet arc. Legacy mode stays available so the existing
 * bootstrap.sh + 6 agent YAMLs keep working during the cutover.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { deriveAgentWallet } from "../../src/wallet/derive.js";
import { loadLoginDomain } from "../../src/wallet/domain.js";
import { signWalletLoginIntent } from "../../src/wallet/signer.js";

const AUTH_MODE = (process.env.RT_AGENT_AUTH_MODE || "wallet").toLowerCase();
const API_URL =
  process.env.RT_AGENT_BACKEND_URL ||
  process.env.REZONTREE_API_URL ||
  "http://localhost:8080";

// ─── wallet-mode env ───────────────────────────────────────
const AGENT_MNEMONIC = process.env.RT_AGENT_MNEMONIC || "";
const AGENT_INDEX = Number.parseInt(process.env.RT_AGENT_INDEX || "-1", 10);

// ─── legacy-mode env ───────────────────────────────────────
const AGENT_SECRET = process.env.REZONTREE_AGENT_SECRET || "";

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
 * Dispatches to the right auth path based on AUTH_MODE. Caches
 * tokens with a 30s early-refresh buffer.
 */
async function getAgentToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_LEAD_MS) {
    return cachedToken.jwt;
  }

  if (AUTH_MODE === "wallet") {
    return await getWalletToken();
  }
  if (AUTH_MODE === "legacy") {
    return await getLegacyToken();
  }
  throw new Error(
    `RT_AGENT_AUTH_MODE=${AUTH_MODE} is invalid. Use "wallet" or "legacy".`,
  );
}

/**
 * Wallet auth: derive → sign WalletLoginIntent → POST /auth/wallet.
 * Backend recovers the signer's address from the signature and
 * looks up the agent by (address, chainId). Unknown wallets are
 * auto-registered (loop 0046 backend behavior).
 */
async function getWalletToken(): Promise<string> {
  if (!AGENT_MNEMONIC) {
    throw new Error(
      "RT_AGENT_MNEMONIC not set (wallet auth mode requires it — see docs/testnet-migration-plan.md)",
    );
  }
  if (!Number.isInteger(AGENT_INDEX) || AGENT_INDEX < 0) {
    throw new Error(
      `RT_AGENT_INDEX must be a non-negative integer, got ${process.env.RT_AGENT_INDEX}`,
    );
  }

  const domain = loadLoginDomain();
  const wallet = deriveAgentWallet(
    AGENT_MNEMONIC,
    AGENT_INDEX,
    domain.chainId,
  );
  const body = await signWalletLoginIntent({
    wallet,
    issuedAt: Math.floor(Date.now() / 1000),
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
 * Legacy client_credentials bearer auth. Kept for agents that
 * haven't migrated to the wallet-atomic identity yet.
 */
async function getLegacyToken(): Promise<string> {
  if (!AGENT_SECRET) {
    throw new Error(
      "REZONTREE_AGENT_SECRET not set (legacy auth mode requires it)",
    );
  }
  const resp = await fetch(`${API_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_secret: AGENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Legacy auth failed: ${resp.status} ${err}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    jwt: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
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
  "Submit a solution to a problem. Must include summary, reasoning_tree, and claims for each success criterion.",
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
    const result = await apiCall(
      "POST",
      `/v1/problems/${params.problem_id}/solutions`,
      {
        summary: params.summary,
        reasoning_tree: params.reasoning_tree,
        claims: params.claims,
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
  "Cast a vote distributing conviction points across solutions. Each agent gets 100 points, min 10 per allocation.",
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
            .describe("Explanation for this allocation (max 500 chars)"),
        }),
      )
      .describe("Point allocations across solutions"),
  },
  async (params) => {
    const result = await apiCall(
      "POST",
      `/v1/problems/${params.problem_id}/votes`,
      { allocations: params.allocations },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
