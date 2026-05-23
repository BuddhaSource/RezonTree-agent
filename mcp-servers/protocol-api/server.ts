#!/usr/bin/env npx tsx
/**
 * RezonTree Protocol MCP Server
 *
 * Exposes the RezonTree consensus protocol as MCP tools. Each tool
 * maps to an HTTP or on-chain Router entry point.
 *
 * Authentication: derive an HD wallet from RT_AGENT_MNEMONIC at
 * RT_AGENT_INDEX, sign an EIP-712 WalletLoginIntent, POST to
 * /v1/sessions. Backend auto-registers unknown wallets.
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
import { createPublicClient, formatUnits, http, parseUnits } from "viem";
import { deriveAgentWallet } from "../../src/wallet/derive.js";
import { loadLoginDomain } from "../../src/wallet/domain.js";
import { signWalletLoginIntent } from "../../src/wallet/signer.js";
import { parseAmountToWei } from "../../src/intents/sponsor-intent.js";
import { canonicalStringify } from "../../src/intents/commit-intent.js";
import type {
  CommitPreflight,
  FundPreflight,
  VotePreflight,
} from "../../src/intents/preflight-types.js";
import {
  awaitReceipt,
  broadcastClaim,
  makeAgentWalletClient,
} from "../../src/forge/client.js";
import {
  ensureUsdcAllowance,
  runCommitFlow,
  runCosponsorFlow,
  runSponsorFlow,
  runVoteFlow,
} from "../../src/forge/quadphase-flow.js";

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

const USDC_ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Pre-flight balance gate.
//
// Authoritative path: the backend's preflight response carries a
// `caller` block (address + balance + required + sufficient). When
// present, we trust it — the backend already did the eth_call and
// computed the comparison. R-CLIENT-IS-TRUST-ORIGIN holds because
// we still reject before signing, and the wallet would display the
// permit struct anyway.
//
// Fallback path: when the backend lacks a balance reader (no RPC in
// dev, or older deployments), `caller` is null. Read balanceOf
// ourselves so the gate still fires. One eth_call (~20ms) + we never
// sign a transfer the chain will reject.
async function assertSpendableUSDC(
  // biome-ignore lint/suspicious/noExplicitAny: viem PublicClient type
  publicClient: any,
  address: Address,
  requiredWei: bigint,
  action: string,
  callerFromPreflight?: {
    sufficient: boolean;
    balanceRaw: string;
    balanceFormatted: string;
    requiredRaw: string;
    requiredFormatted: string;
    shortfallRaw: string;
    shortfallFormatted: string;
    topupHint?: string;
    token: { contractAddress: string; decimals: number; symbol: string; chainId: number };
  } | null,
): Promise<void> {
  const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(6);

  if (callerFromPreflight) {
    if (callerFromPreflight.sufficient) return;
    throw new StructuredMCPError({
      code: "INSUFFICIENT_BALANCE",
      message: `${action}: balance ${callerFromPreflight.balanceFormatted} < required ${callerFromPreflight.requiredFormatted}.`,
      action: `${callerFromPreflight.topupHint ?? "Top up the wallet via wallet_topup_faucet (testnet) or transfer the missing amount to this address."} No intent was signed.`,
      details: {
        balance: callerFromPreflight.balanceFormatted,
        required: callerFromPreflight.requiredFormatted,
        shortfall: callerFromPreflight.shortfallFormatted,
        balanceRaw: callerFromPreflight.balanceRaw,
        requiredRaw: callerFromPreflight.requiredRaw,
        shortfallRaw: callerFromPreflight.shortfallRaw,
        token: callerFromPreflight.token,
        address,
        source: "preflight",
      },
    });
  }

  const balance = (await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: USDC_ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  if (balance >= requiredWei) return;
  const shortfall = requiredWei - balance;
  throw new StructuredMCPError({
    code: "INSUFFICIENT_BALANCE",
    message: `${action}: on-chain USDC balance ${fmt(balance)} < required ${fmt(requiredWei)} (short ${fmt(shortfall)}).`,
    action: `Call wallet_topup_faucet for ${address} (testnet) or transfer USDC to this address before retrying. No intent was signed; no chain action taken.`,
    details: {
      currentBalanceUsdc: fmt(balance),
      requiredUsdc: fmt(requiredWei),
      shortfallUsdc: fmt(shortfall),
      address,
      token: USDC_ADDRESS,
      source: "fallback",
    },
  });
}

// ensureUsdcCoverage is the chain-write USDC prologue used by every
// USDC-consuming tool (submit_solution, cast_vote, sponsor_question,
// cosponsor_question). It checks the caller's balance covers the
// required wei, then approves the forge for an unbounded allowance
// (one approve per wallet/forge, idempotent). Extracted from the
// four call sites where the same two-step ceremony was inlined —
// byte-identical observable behaviour, single source of truth for
// the assertSpendableUSDC action label, and a single seam where any
// future preflight-bound balance check would land.
async function ensureUsdcCoverage(
  // biome-ignore lint/suspicious/noExplicitAny: viem PublicClient
  publicClient: any,
  // biome-ignore lint/suspicious/noExplicitAny: viem WalletClient
  walletClient: any,
  address: Address,
  required: bigint,
  action: string,
  forge: Address,
  callerFromPreflight: Parameters<typeof assertSpendableUSDC>[4],
): Promise<void> {
  await assertSpendableUSDC(publicClient, address, required, action, callerFromPreflight);
  // BountyForge uses safeTransferFrom for fee + stake escrow — no
  // inline EIP-2612 permit. One MAX_UINT256 approve per wallet/forge.
  await ensureUsdcAllowance(walletClient, publicClient, {
    usdc: USDC_ADDRESS,
    forge,
    owner: address,
    required,
  });
}

// resolvePlatformFeeRecipient returns the address that receives the
// platform fee share. Preflight echoes it; absence falls back to the
// zero address (no fee recipient → fee accrues to the pool). Duplicated
// inline at every USDC-consuming flow site before this extraction.
function resolvePlatformFeeRecipient(
  pre: { platformFeeRecipient?: string | null },
): `0x${string}` {
  return (
    (pre.platformFeeRecipient as `0x${string}` | undefined) ??
    ("0x0000000000000000000000000000000000000000" as `0x${string}`)
  );
}

// ─── Structured MCP error + backend envelope surfacing ─────
//
// MCP tools surface errors back to the agent as text. A bare
// `throw new Error("...")` flattens into a single string and the
// agent loses the {code, action, requestId, ...} contract the rest
// of the protocol speaks. StructuredMCPError serializes the wire
// envelope so an agent can pattern-match on `errorCode` and follow
// `errorAction` regardless of where in the stack the error
// originated. parseBackendErrorEnvelope converts the backend's
// AppError body (non-2xx response) into StructuredMCPError args
// while preserving every field the backend sent (SCHEMA_CHANGED's
// diff/schema, validation fieldErrors, etc.). Both live in
// `./errors.ts` so the unit test suite can import them without
// paying the cost of evaluating server.ts (which binds stdio on
// import).
import { StructuredMCPError, parseBackendErrorEnvelope } from "./errors.js";

// ─── Input safety helpers ────────────────────────────────────
//
// Threat model: agent-supplied identifiers (question_id, address,
// bytes32 overrides) are interpolated directly into URL path
// segments and query strings (e.g. `/v1/questions/${question_id}/...`).
// A malicious or buggy agent that passes `qst_x/../accounts/admin`
// would re-route the API call to an unintended endpoint, and one that
// passes `addr&admin=true` would graft extra query params onto the
// request. zod's `z.string()` alone doesn't fence these — we MUST
// validate the shape *before* interpolation.
//
// Accepted shapes:
//   QID_RE       qst_…/sol_…/vot_…/rnd_…/ctr_…  (crockford32 body)
//   ADDR_RE      0x + 40 lowercase-or-uppercase hex chars
//   BYTES32_RE   0x + 64 hex chars
//
// Reject anything else as STRUCTURED_INPUT_INVALID — the agent retries
// with a corrected ID rather than us silently producing a malformed
// request.
const QID_RE = /^[a-z]{3}_[0-9A-Za-z]{1,64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function assertQuestionId(id: string, field = "question_id"): void {
  if (!QID_RE.test(id)) {
    throw new StructuredMCPError({
      code: "STRUCTURED_INPUT_INVALID",
      message: `${field}=${JSON.stringify(id)} is not a valid protocol ID (expected '<prefix>_<crockford32>' like 'qst_abc123').`,
      action: `Pass a well-formed ID. Path-traversal characters (/, .., %, ?, &, #) and whitespace are rejected before any backend call.`,
    });
  }
}

function assertAddress(addr: string, field = "address"): void {
  if (!ADDR_RE.test(addr)) {
    throw new StructuredMCPError({
      code: "STRUCTURED_INPUT_INVALID",
      message: `${field}=${JSON.stringify(addr)} is not a valid 0x-prefixed 20-byte hex address.`,
      action: `Pass an EVM address matching /^0x[0-9a-fA-F]{40}$/. The MCP rejects URL-path injection attempts at the boundary.`,
    });
  }
}

function assertBytes32(v: string, field: string): void {
  if (!BYTES32_RE.test(v)) {
    throw new StructuredMCPError({
      code: "STRUCTURED_INPUT_INVALID",
      message: `${field}=${JSON.stringify(v)} is not a valid 0x-prefixed 32-byte hex value.`,
      action: `Pass a value matching /^0x[0-9a-fA-F]{64}$/.`,
    });
  }
}

// redactBearer is now shared with the SDK flow helpers — see
// ../../src/utils/redact.ts. Kept as a local re-export here so the
// existing call sites don't need import-path churn.
import { redactBearer } from "../../src/utils/redact.js";

// safeJSONStringify is the canonical encoder for tool responses.
// Replacer (a) converts bigint → string verbatim so the JSON.stringify
// default — which throws on bigint — never bites a tool that forgot to
// `.toString()` a value, and (b) drops Authorization-like fields so
// `details` payloads can't accidentally surface a captured header
// blob. Used by textResponse so every cached + replayed response
// passes through one funnel.
function safeJSONStringify(value: unknown, indent = 2): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
      }
      if (
        typeof v === "string" &&
        (key.toLowerCase() === "authorization" ||
          key.toLowerCase() === "bearertoken" ||
          key.toLowerCase() === "bearer_token" ||
          key.toLowerCase() === "accesstoken" ||
          key.toLowerCase() === "access_token" ||
          key.toLowerCase() === "jwt")
      ) {
        // Note: get_session_token deliberately returns accessToken,
        // and it constructs its JSON.stringify directly (not via this
        // helper), so this redaction won't strip the legitimate
        // session-token surface. snake_case + lowercase variants
        // added per security audit H5 — third-party libraries
        // sometimes serialize tokens under non-camelCase keys.
        return "<redacted>";
      }
      if (typeof v === "string") return redactBearer(v);
      return v;
    },
    indent,
  );
}

// ─── expectedIntentHash gate ─────────────────────────────────
//
// Round-3 preflight responses carry `expectedIntentHash` — the
// server's recompute of the EIP-712 intentHash for the canonical
// envelope the client is about to sign. Posting the value verbatim
// on the unified submit lets the backend dispatcher reject any
// client recompute drift before Stage-2 work. The zero sentinel
// "0x0000…" or absent field is a backend stub path (claim/refund
// pre-population, settle stub) — for the four chain-bound action
// flows the SDK exercises today (sponsor / cosponsor / commit /
// vote), the field MUST be populated and non-zero. Fail loud rather
// than ship the zero sentinel to the dispatcher (which would
// surface as a confusing Stage-2 contentHash reject).
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// requireFrozenFeeShareBps + requireFrozenFeeShares pull the frozen
// per-question fee-share policy off a commit/vote preflight response
// (#619). The backend reads the policy from the initial sponsor's
// contribution row and emits it on preflight so clients echo it bit-
// for-bit into the witness; chain reverts any mismatch. Throw rather
// than substitute defaults — a missing policy means the question
// either has no confirmed sponsor yet (don't sign), or the backend
// is older than the #619 fix (upgrade backend).
function requireFrozenFeeShareBps(
  pre: { feeShareBps?: number },
  flow: string,
): number {
  if (pre.feeShareBps === undefined || pre.feeShareBps === null) {
    throw new StructuredMCPError({
      code: "PREFLIGHT_MISSING_FEE_SHARE_BPS",
      message: `${flow} preflight did not return feeShareBps; cannot construct a witness whose feeShares match the chain-frozen policy.`,
      action:
        "Confirm the question has a confirmed initial sponsor (GET /v1/questions/:id, sponsors[].isInitial=true with confirmation_status=confirmed). If yes, upgrade the backend to a build that includes #619.",
    });
  }
  return pre.feeShareBps;
}

function requireFrozenFeeShares(
  pre: { feeShares?: { recipient: string; basisPoints: number }[] },
  flow: string,
  platformFeeRecipientFallback?: `0x${string}`,
): { recipient: `0x${string}`; basisPoints: number }[] {
  if (!pre.feeShares || pre.feeShares.length === 0) {
    // Backend bug #619: preflight returns feeShareBps but omits feeShares[].
    // When platformFeeRecipient is known, reconstruct the minimal chain-valid
    // policy that the initial sponsor always posts (100% of fee to platform).
    // RezonForge._validateFeeSharePolicy rejects empty arrays unconditionally,
    // so we MUST emit at least one recipient even when feeShareBps is 0.
    const ZERO = "0x0000000000000000000000000000000000000000";
    if (platformFeeRecipientFallback && platformFeeRecipientFallback !== ZERO) {
      return [{ recipient: platformFeeRecipientFallback, basisPoints: 10000 }];
    }
    throw new StructuredMCPError({
      code: "PREFLIGHT_MISSING_FEE_SHARES",
      message: `${flow} preflight returned no feeShares; the chain reverts a witness whose feeShares[] doesn't match the frozen policy.`,
      action:
        "Confirm the question has a confirmed initial sponsor (GET /v1/questions/:id, sponsors[].isInitial=true). If yes, upgrade the backend to a build that includes #619.",
    });
  }
  return pre.feeShares.map((s) => ({
    recipient: s.recipient as `0x${string}`,
    basisPoints: s.basisPoints,
  }));
}

function requireExpectedIntentHash(
  pre: { expectedIntentHash?: string },
  flow: string,
): `0x${string}` {
  // Audit H3: removed the `?? pre.qid` fallback. qid is the
  // deterministic question identifier (hash of questionID+chainID);
  // expectedIntentHash is the EIP-712 envelope hash. They are
  // structurally different bytes32 values. Falling back conflated
  // them and silently disabled the Stage-2 intent-hash drift gate.
  // If preflight didn't return expectedIntentHash, fail loud.
  const v = pre.expectedIntentHash ?? "";
  if (!v || v.toLowerCase() === ZERO_BYTES32) {
    throw new StructuredMCPError({
      code: "PREFLIGHT_MISSING_INTENT_HASH",
      message: `${flow} preflight did not return a populated expectedIntentHash; the backend cannot fence Stage-2 drift without it.`,
      action:
        "Re-fetch /v1/questions/:id/intents/preflight with the correct {actionType, params} body. If the response still omits expectedIntentHash, the backend version may be pre-Round 3 — upgrade backend.",
    });
  }
  return v as `0x${string}`;
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
const IDEM_CACHE_MAX_ENTRIES = 1024;
const idempotencyCache = new Map<string, CacheEntry>();

// proofFingerprint returns a short stable hash of a Merkle proof
// array so it can be folded into the idempotency cache key without
// blowing up its size. Two proofs with the same elements in the same
// order produce the same fingerprint; order matters because Merkle
// proofs are sibling-ordered. Audit finding #613/#614: claim_payout
// retries with a different `proof` override would otherwise replay
// the cached tx_hash from the wrong claim state. Empty proof hashes
// the empty string so single-leaf trees share one namespace with
// multi-leaf ones.
function proofFingerprint(proof: Hex[]): string {
  return createHash("sha256")
    .update(proof.join("|"))
    .digest("hex")
    .slice(0, 16);
}

function idempotencyKey(action: string, params: unknown): string {
  const paramsJSON = canonicalStringify(params);
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

// pruneIdempotencyCache evicts expired entries + caps cache size to
// IDEM_CACHE_MAX_ENTRIES. Without this the Map grew unbounded for
// long-running agents (audit finding #614b). Called from setCached
// once per IDEM_CACHE_SWEEP_EVERY writes so the amortised cost is
// negligible. Eviction order: oldest-first by timestamp (LRU-ish —
// Map iteration is insertion order which is close enough).
const IDEM_CACHE_SWEEP_EVERY = 32;

function pruneIdempotencyCache(): void {
  const now = Date.now();
  for (const [k, v] of idempotencyCache) {
    if (now - v.timestamp > IDEM_CACHE_TTL_MS) {
      idempotencyCache.delete(k);
    }
  }
  while (idempotencyCache.size > IDEM_CACHE_MAX_ENTRIES) {
    const oldest = idempotencyCache.keys().next().value;
    if (oldest === undefined) break;
    idempotencyCache.delete(oldest);
  }
}

// Closure-scoped write counter — module-level mutable state was test
// surface area for nothing; the counter is purely internal.
const setCached: (key: string, result: unknown) => void = (() => {
  let writesSinceSweep = 0;
  return (key, result) => {
    idempotencyCache.set(key, { timestamp: Date.now(), result });
    if (++writesSinceSweep >= IDEM_CACHE_SWEEP_EVERY) {
      writesSinceSweep = 0;
      pruneIdempotencyCache();
    }
  };
})();

function textResponse(result: unknown, replay = false) {
  // Threat model: tool bodies sometimes return bigints (USDC wei, nonces)
  // without an explicit `.toString()`. The default JSON.stringify throws
  // on bigint, taking the entire tool call down. safeJSONStringify also
  // strips bearer-token-shaped substrings so a cached error envelope that
  // captured an upstream-proxy echo can never re-surface a JWT.
  const body =
    typeof result === "string" ? redactBearer(result) : safeJSONStringify(result);
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
// 60 s early to absorb both the refresh round-trip (network + sign +
// /v1/sessions) AND clock skew between the agent host + backend. The
// 30 s lead was too aggressive — mega25 retro caught solver-04 hitting
// UNAUTHORIZED mid-session because the token expired mid-flight on a
// slow Stage-2 submit (~2 s on a busy backend, leaving zero margin).
const JWT_TTL_MS = 15 * 60 * 1000;
const REFRESH_LEAD_MS = 60_000;

let cachedToken: {
  jwt: string;
  expiresAt: number;
} | null = null;

// Promise memoization to prevent the cold-start stampede: when N tool
// calls arrive concurrently before the first login completes, each
// would otherwise sign its own (deterministic) WalletLoginIntent and
// POST to /v1/sessions — backend's replay-dedup table treats all but
// the first as a 409 conflict. By sharing one in-flight promise, every
// concurrent caller receives the same JWT from a single login round-trip.
let inflightLogin: Promise<string> | null = null;

/**
 * Wallet auth: derive → sign WalletLoginIntent → POST /v1/sessions.
 * Backend recovers the signer's address from the signature and
 * looks up (or auto-registers) the agent by (address, chainId).
 * Tokens cached with a 30s early-refresh buffer; concurrent cold-cache
 * callers share one in-flight login.
 */
async function getAgentToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_LEAD_MS) {
    return cachedToken.jwt;
  }
  if (inflightLogin) return inflightLogin;

  inflightLogin = doLogin().finally(() => {
    inflightLogin = null;
  });
  return inflightLogin;
}

async function doLogin(): Promise<string> {
  if (!AGENT_MNEMONIC) {
    throw new StructuredMCPError({
      code: "AUTH_CONFIG_MISSING",
      message: "RT_AGENT_MNEMONIC is not set",
      action: "Set RT_AGENT_MNEMONIC in your environment (see .env.example) and restart the MCP server.",
    });
  }
  if (!Number.isInteger(AGENT_INDEX) || AGENT_INDEX < 0) {
    throw new StructuredMCPError({
      code: "AUTH_CONFIG_MISSING",
      message: `RT_AGENT_INDEX must be a non-negative integer, got ${process.env.RT_AGENT_INDEX}`,
      action: "Set RT_AGENT_INDEX to an integer >= 1 (operator is 0, agents 1+).",
    });
  }

  const domain = loadLoginDomain();
  const wallet = deriveAgentWallet(AGENT_MNEMONIC, AGENT_INDEX, domain.chainId);
  const body = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain,
  });

  let resp: Response;
  try {
    resp = await fetch(`${API_URL}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new StructuredMCPError({
      code: "AUTH_TRANSPORT_FAILED",
      message: `Could not reach backend /v1/sessions: ${e instanceof Error ? e.message : String(e)}`,
      action: `Verify RT_AGENT_BACKEND_URL (currently ${API_URL}) is reachable and backend is healthy. Retry.`,
    });
  }

  const rawText = await resp.text();
  let raw: unknown = {};
  if (rawText.length > 0) {
    try {
      raw = JSON.parse(rawText);
    } catch {
      // Threat model (JWT leakage): a misbehaving upstream (proxy, LB,
      // backend debug page) can echo the request — including its
      // Authorization header — in a non-JSON body. Redact before
      // surfacing into the error envelope that reaches the LLM caller.
      raw = { _rawBody: redactBearer(rawText) };
    }
  }
  if (!resp.ok) {
    throw new StructuredMCPError(
      parseBackendErrorEnvelope({
        data: raw,
        rawText: redactBearer(rawText),
        status: resp.status,
        codePrefix: "AUTH_HTTP_",
        fallbackAction:
          "Retry once. If persistent, check backend logs.",
      }),
    );
  }
  const data = raw as { accessToken: string; expiresIn?: number };
  // Prefer the backend's own expiresIn when available — operators can
  // override ACCESS_TOKEN_TTL, and the local clock may be skewed against
  // the backend clock. Fall back to JWT_TTL_MS if the field is missing.
  const ttlMs =
    typeof data.expiresIn === "number" && data.expiresIn > 0
      ? data.expiresIn * 1000
      : JWT_TTL_MS;
  cachedToken = { jwt: data.accessToken, expiresAt: Date.now() + ttlMs };
  return cachedToken.jwt;
}

/**
 * Make an authenticated API call. Auto-retries once on 401 with a
 * fresh token — covers operator ACCESS_TOKEN_TTL overrides + clock
 * skew without surfacing transient auth failures to agents.
 */
async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
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
    // Read body once as text, then try JSON-parse. This way a non-JSON
    // upstream-proxy response (502 HTML, plain "Bad Gateway") still
    // surfaces its bytes to the caller instead of an opaque "{}".
    const rawText = await resp.text();
    let data: unknown = {};
    if (rawText.length > 0) {
      try {
        data = JSON.parse(rawText);
      } catch {
        // Threat model (JWT leakage + JSON.parse robustness): if the
        // body is not JSON (proxy HTML, plain "Bad Gateway", etc.), we
        // surface its text. Some misconfigured proxies echo request
        // headers — strip any bearer-token-shaped strings before they
        // re-enter the agent's context window.
        data = { _rawBody: redactBearer(rawText) };
      }
    }

    if (resp.status === 401 && attempt === 0) {
      cachedToken = null;
      continue;
    }
    // Second consecutive 401 = legitimate auth failure (revoked wallet,
    // wrong mnemonic, backend rotated the JWT secret). Surface a
    // distinct code so agents stop retrying — looping a re-auth that
    // can't succeed burns budget and produces noise.
    if (resp.status === 401 && attempt === 1) {
      throw new StructuredMCPError({
        code: "AUTH_REFRESH_FAILED",
        message:
          "Re-authentication did not yield a valid JWT — second 401 in a row.",
        action:
          "Stop calling this tool. Check that RT_AGENT_MNEMONIC matches a wallet the backend has not revoked. If the backend rotated its JWT signing key, every agent in the bank needs a coordinated session restart — not a retry from this agent. Verify with: GET /healthz on the backend, then a manual POST /v1/sessions.",
        httpStatus: 401,
      });
    }

    if (!resp.ok) {
      // Backend envelope is `{ error: { code, message, action,
      // requestId, details?, fieldErrors? } }` (wire field is
      // requestId camelCase per AppError.ToResponse). Preserve every
      // key the backend sent so SCHEMA_CHANGED's `diff`/`schema` and
      // validation's `fieldErrors` propagate verbatim.
      throw new StructuredMCPError(
        parseBackendErrorEnvelope({
          data,
          rawText: redactBearer(rawText),
          status: resp.status,
          codePrefix: "HTTP_",
          fallbackAction:
            "Inspect the response body and retry. If persistent, check backend logs.",
        }),
      );
    }
    return data;
  }
  // Unreachable — the loop returns or throws on every iteration.
  throw new Error("apiCall: exhausted retry attempts");
}

// ── MCP Server Setup ─────────────────────────────────────────────────

const server = new McpServer({
  name: "rezontree-protocol",
  version: "1.0.0",
});

// ── Backend-wire-shape tools moved to hosted MCP ─────────────────────
//
// The local SDK no longer wraps backend HTTP endpoints. Per the
// hosted-MCP-first architecture, agents read these from the hosted MCP
// at http://localhost:8080/mcp. The mapping:
//   get_protocol            → rezontree_protocol_list_protocol
//   list_questions          → rezontree_questions_list_questions
//   get_question            → rezontree_questions_get_question
//   list_solutions          → rezontree_solutions_list_solutions
//   list_votes              → rezontree_votes_list_votes
//   close_question          → rezontree_resolution_patch_questions
//   get_result              → rezontree_resolution_list_result
//   get_wallet_transactions → rezontree_accounts_list_transactions
//   get_account_profile     → rezontree_accounts_list_profile
//   get_pending_intents     → rezontree_me_list_pending
//   check_round_status      → rezontree_rounds_get_round
//   debug_question_state    → composite of hosted reads (no local wrapper)
//
// Keeping local wrappers means SDK schema drifts every time the backend
// evolves. The hosted MCP is the single source of truth for backend
// wire shapes; the SDK only exposes wallet + sign + broadcast +
// methodology + chain-bound composites.

// ── Solutions ────────────────────────────────────────────────────────

server.tool(
  "submit_solution",
  "Submit a solution via the Quadphase v2 unified-envelope flow: preflight → build CommitWitness from {body, reasoning_tree, claims} → sign Envelope(action=Commit) → POST /v1/questions/:id/intents (backend stages solution row + signed_intents row in one tx) → ensure USDC allowance → broadcast BountyForge.submit(env, sig). Returns intent_hash + commit_tx_hash. Backend row flips pending→confirmed when Ponder ingests the chain event (~3s).",
  {
    question_id: z.string().describe("The question ID to solve"),
    body: z
      .string()
      .describe("Solution body — markdown allowed, 2000–30000 chars"),
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
    // QP Stage 1 — boundary check: validate the ID shape before any
    // URL interpolation so a `qst_x/../accounts/admin` injection can't
    // re-route the backend call. See assertQuestionId for threat model.
    assertQuestionId(params.question_id);
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
          "POST",
          `/v1/questions/${params.question_id}/intents/preflight?submitter=${address}`,
          { actionType: "commit", params: { submitter: address } },
        )) as CommitPreflight;

        const feeAmount = BigInt(pre.feeAmount);
        const stakeAmount = BigInt(pre.stakeAmount);

        await ensureUsdcCoverage(
          publicClient,
          walletClient,
          address,
          feeAmount + stakeAmount,
          "submit_solution",
          env.router,
          pre.caller ?? null,
        );

        // CommitWitness.solutionBody is a canonical JSON string of the
        // structured body ({body, reasoningTree, claims}) — same shape the
        // backend canonicalises into solutions.body. References array is
        // empty at this surface (the agent input has no separate references
        // field; reasoningTree + claims already cite their support).
        const solutionBodyJSON = canonicalStringify({
          body: params.body,
          reasoningTree: params.reasoning_tree,
          claims: params.claims.map((c) => ({
            criterionId: c.criterion_id,
            value: c.value,
            argument: c.argument,
            falsifiableBy: c.falsifiable_by,
          })),
        });

        const bearer = await getAgentToken();
        const expiresAt = BigInt(
          pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300,
        );
        const nonce = BigInt(pre.nonce ?? "0");
        const platformFeeRecipient = resolvePlatformFeeRecipient(pre);

        try {
          const result = await runCommitFlow({
            baseUrl: API_URL,
            bearerToken: bearer,
            signer: address,
            questionId: params.question_id,
            qid: pre.qid as `0x${string}`,
            nonce,
            expiresAt,
            forgeAddress: env.router,
            chainId: pre.chainId ?? CHAIN_ID,
            // expectedIntentHash omitted: commit preflight cannot pre-compute it
            // because contentHash depends on the solution body (unknown at preflight).
            // runCommitFlow derives it locally via hashTypedData() — see CommitFlowParams.
            solutionBody: solutionBodyJSON,
            references: [],
            token: pre.token.contractAddress as `0x${string}`,
            feeAmount,
            stakeAmount,
            // Frozen by the first sponsor; preflight echoes the policy
            // bit-for-bit. The chain reverts a commit whose feeShares
            // don't match — see preflight-types.ts. Throw rather than
            // silently substituting a default; pre-sponsor questions
            // shouldn't be reaching submit_solution.
            feeShareBps: requireFrozenFeeShareBps(pre, "commit"),
            feeShares: requireFrozenFeeShares(pre, "commit", platformFeeRecipient),
            walletClient,
            privateKey,
          });
          await awaitReceipt(publicClient, result.txHash!);

          return {
            intent_hash: result.intentHash,
            commit_tx_hash: result.txHash!,
            fee_paid: feeAmount.toString(),
            stake_paid: stakeAmount.toString(),
            note: "Backend row flips pending→confirmed within one Ponder tick (~3s).",
          };
        } catch (err) {
          if (err instanceof StructuredMCPError) throw err;
          throw new StructuredMCPError({
            code: "SUBMIT_SOLUTION_PARTIAL_FAILURE",
            message: `submit_solution: Commit envelope flow failed: ${err instanceof Error ? err.message : String(err)}`,
            action:
              "If the backend POST succeeded but broadcast failed, the staged intent will expire automatically (default ~5 min). Call rezontree_me_list_pending (hosted MCP) to inspect lifecycle. Do NOT re-call submit_solution before the intent expires; it would burn a fresh nonce.",
            details: {
              questionId: params.question_id,
            },
          });
        }
      },
    );
  },
);

// ── Votes ────────────────────────────────────────────────────────────

server.tool(
  "cast_vote",
  "Cast a vote via the Quadphase v2 unified-envelope flow: preflight (returns voteSalt + voteSaltToken) → build VoteWitness(allocations, salt) → sign Envelope(action=Vote) → POST /v1/questions/:id/intents (backend re-binds the salt token + stages votes row + vote_allocations rows in one tx) → ensure USDC allowance → broadcast BountyForge.submit(env, sig). Stake is locked by the forge and refunded at settlement; wrong-voter stakes are slashed into the pool. allocations[].conviction_points use the 100-point budget and are scaled to basis points (×100) on the envelope.",
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
    // QP Stage 1 — boundary check: see assertQuestionId threat model.
    assertQuestionId(params.question_id);
    for (const a of params.allocations) {
      assertQuestionId(a.solution_id, "allocations[].solution_id");
    }
    const env = requireRouterEnv();
    const { walletClient, publicClient, privateKey, address } = getClients();

    return withIdempotency(
      "cast_vote",
      { addr: address, pid: params.question_id, allocs: params.allocations },
      async () => {
        const pre = (await apiCall(
          "POST",
          `/v1/questions/${params.question_id}/intents/preflight?voter=${address}`,
          { actionType: "vote", params: { voter: address } },
        )) as VotePreflight;

        if (!pre.voteSalt || !pre.voteSaltToken) {
          throw new StructuredMCPError({
            code: "VOTE_SALT_MISSING",
            message:
              "Vote preflight did not return voteSalt + voteSaltToken; the backend requires both for privacy.",
            action:
              "Re-fetch POST /v1/questions/:id/intents/preflight with body {actionType:'vote', params:{voter:<addr>}}. If still missing, the backend version may not support the vote-allocation salt — upgrade the backend.",
          });
        }
        const voteSalt = pre.voteSalt as `0x${string}`;
        const voteSaltToken = pre.voteSaltToken as `0x${string}`;

        // ── Resolve sol_xxx API IDs → bytes32 intentHashes ───────────────
        // The EIP-712 Allocation struct uses bytes32 solutionId, which is the
        // on-chain intentHash of the committed solution — NOT the human-readable
        // sol_xxx API ID (24 ASCII bytes → bytes24, which viem rejects as bytes32).
        // Fetch the question's confirmed solutions to build the lookup map.
        const solResp = (await apiCall(
          "GET",
          `/v1/questions/${params.question_id}?include=solutions`,
        )) as { solutions: { data: Array<{ id: string; intentHash: string }> } };

        const intentHashBySolId = new Map<string, `0x${string}`>(
          (solResp.solutions?.data ?? []).map((s) => [
            s.id,
            s.intentHash as `0x${string}`,
          ]),
        );

        // Validate every allocated solution ID resolves to a confirmed intentHash.
        for (const a of params.allocations) {
          if (!intentHashBySolId.has(a.solution_id)) {
            throw new StructuredMCPError({
              code: "VOTE_SOLUTION_NOT_FOUND",
              message: `Allocated solution ${a.solution_id} not found in confirmed solutions for question ${params.question_id}.`,
              action: `Verify the solution ID is confirmed via GET /v1/questions/${params.question_id}?include=solutions and retry with a valid solution_id.`,
            });
          }
        }

        // Convert MCP conviction-points (sum=100 budget) → basis-points
        // (sum=10000). Each input point becomes 100 bps. Rejects fractional
        // points loudly — the agent must allocate whole points.
        let bpsSum = 0;
        const v2Allocations = params.allocations.map((a) => {
          if (!Number.isInteger(a.conviction_points)) {
            throw new StructuredMCPError({
              code: "VOTE_FRACTIONAL_POINTS",
              message: `Allocation for ${a.solution_id} has fractional conviction_points (${a.conviction_points}); v2 requires whole-integer points.`,
              action:
                "Round to whole conviction_points before calling cast_vote. The 100-point budget maps directly to 10000 basis points.",
            });
          }
          const bps = a.conviction_points * 100;
          bpsSum += bps;
          return {
            // Use intentHash (bytes32) not the sol_xxx API ID string (bytes24)
            solutionId: intentHashBySolId.get(a.solution_id) as `0x${string}`,
            basisPoints: bps,
          };
        });
        if (bpsSum !== 10000) {
          throw new StructuredMCPError({
            code: "VOTE_BPS_SUM_MISMATCH",
            message: `Allocation basisPoints sum to ${bpsSum}; must equal 10000 (conviction_points must sum to 100).`,
            action:
              "Rebalance allocations[].conviction_points so they sum to exactly 100. Retry.",
          });
        }

        const feeAmount = BigInt(pre.feeAmount);
        const stakeAmount = BigInt(pre.stakeAmount);

        await ensureUsdcCoverage(
          publicClient,
          walletClient,
          address,
          feeAmount + stakeAmount,
          "cast_vote",
          env.router,
          pre.caller ?? null,
        );

        const bearer = await getAgentToken();
        // The vote-salt HMAC binds (voter, salt, qid, expiresAt) — the
        // envelope's expiresAt MUST equal voteSaltExpiresAt or the
        // backend rejects with "voteSaltToken rejected".
        const expiresAt = BigInt(pre.voteSaltExpiresAt);
        const nonce = BigInt(pre.nonce ?? "0");
        const platformFeeRecipient = resolvePlatformFeeRecipient(pre);

        try {
          const result = await runVoteFlow({
            baseUrl: API_URL,
            bearerToken: bearer,
            signer: address,
            questionId: params.question_id,
            qid: pre.qid as `0x${string}`,
            nonce,
            expiresAt,
            forgeAddress: env.router,
            chainId: pre.chainId ?? CHAIN_ID,
            expectedIntentHash: requireExpectedIntentHash(pre, "vote"),
            allocations: v2Allocations,
            voteSalt,
            voteSaltToken,
            token: pre.token.contractAddress as `0x${string}`,
            feeAmount,
            stakeAmount,
            feeShareBps: requireFrozenFeeShareBps(pre, "vote"),
            feeShares: requireFrozenFeeShares(pre, "vote", platformFeeRecipient),
            walletClient,
            privateKey,
          });
          await awaitReceipt(publicClient, result.txHash!);

          return {
            intent_hash: result.intentHash,
            vote_tx_hash: result.txHash!,
            stake_paid: stakeAmount.toString(),
            fee_paid: feeAmount.toString(),
          };
        } catch (err) {
          if (err instanceof StructuredMCPError) throw err;
          throw new StructuredMCPError({
            code: "CAST_VOTE_PARTIAL_FAILURE",
            message: `cast_vote: Vote envelope flow failed: ${err instanceof Error ? err.message : String(err)}`,
            action:
              "If the backend POST succeeded but broadcast failed, the staged intent will expire automatically. Call rezontree_me_list_pending (hosted MCP) to inspect lifecycle. Do NOT re-call cast_vote before the intent expires; it would burn a fresh nonce.",
            details: {
              questionId: params.question_id,
            },
          });
        }
      },
    );
  },
);

// ── Fund (Router v2 signed-intent + on-chain broadcast) ─────────────

server.tool(
  "fund_question",
  "Fund a question via RezonForge: preflight → sign Sponsor or Cosponsor intent (auto-detected from preflight.mode) → POST /sponsorships → USDC permit → broadcast sponsor()/cosponsor(). The first contributor signs SponsorIntent (binds per-Q params on-chain); subsequent contributors sign CosponsorIntent (inherits chain state). Amount is in human USDC (e.g. '1.5' = 1.5 USDC). IMPORTANT: check get_usdc_balance before calling — this pulls from your on-chain wallet. For first-sponsors, sponsorship_floor defaults to preflight.sponsorship_floor (usually 1 USDC) but can be overridden lower if your balance requires it.",
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
    // QP Stage 1 — boundary check: see assertQuestionId threat model.
    assertQuestionId(params.question_id);
    const env = requireRouterEnv();
    const { walletClient, publicClient, privateKey, address } = getClients();

    return withIdempotency(
      "fund_question",
      { addr: address, pid: params.question_id, amount: params.amount },
      async () => {
        // Backend dispatches both `actionType=sponsor` and
        // `actionType=cosponsor` to the same FundPreflight handler — it
        // disambiguates from chain state and returns `mode`. We can ask
        // with either token; using "sponsor" is the simplest default,
        // and the response.mode field tells us which flow to run.
        const pre = (await apiCall(
          "POST",
          `/v1/questions/${params.question_id}/intents/preflight?sponsor=${address}`,
          { actionType: "sponsor", params: { sponsor: address } },
        )) as FundPreflight;

        const amountWei = parseAmountToWei(params.amount, pre.token.decimals);

        // BountyForge moved off the inline EIP-2612 permit — escrow uses
        // safeTransferFrom. Approve once per wallet/forge pair.
        await ensureUsdcAllowance(walletClient, publicClient, {
          usdc: USDC_ADDRESS,
          forge: env.router,
          owner: address,
          required: amountWei,
        });

        const bearer = await getAgentToken();
        const expiresAt = BigInt(
          pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300,
        );
        const nonce = BigInt(pre.nonce ?? "0");
        const feeShareBps = Number(pre.feeShareBps ?? "0");
        const platformFeeRecipient = resolvePlatformFeeRecipient(pre);

        const fundResp = await (async () => {
          if (pre.mode === "sponsor") {
            // Sponsor flow re-uses the question's title + body from the
            // backend so the on-chain content hash matches what would be
            // emitted via post_question. Fetch the draft row to populate
            // SponsorWitness fields.
            const qDetail = (await apiCall(
              "GET",
              `/v1/questions/${params.question_id}`,
            )) as {
              id: string;
              qid: string;
              title: string;
              description: string;
              tags?: string[];
              successCriteria?: unknown[];
            };
            const sponsorshipFloor = params.sponsorship_floor
              ? parseAmountToWei(params.sponsorship_floor, pre.token.decimals)
              : BigInt(
                  pre.sponsorshipFloor ?? pre.recommendedSponsorshipFloor ?? "0",
                );
            const commitFee = BigInt(pre.commitFee ?? "0");
            const voteFee = BigInt(pre.voteFee ?? "0");
            const stakeFloor = BigInt(pre.stakeFloor ?? "0");
            const stakeBasisPoints = Number(pre.stakeBasisPoints ?? "0");
            const noSolutionGracePeriod = BigInt(
              pre.noSolutionGracePeriod ?? "86400",
            );
            const fundingDeadline = BigInt(
              pre.recommendedFundingDeadline ??
                Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            );
            const oracle =
              (pre.oracle as `0x${string}` | undefined) ?? address;
            const result = await runSponsorFlow({
              baseUrl: API_URL,
              bearerToken: bearer,
              signer: address,
              questionId: params.question_id,
              qid: pre.qid as `0x${string}`,
              nonce,
              expiresAt,
              forgeAddress: env.router,
              chainId: pre.chainId ?? CHAIN_ID,
              expectedIntentHash: requireExpectedIntentHash(pre, "sponsor"),
              title: qDetail.title,
              body: qDetail.description,
              criteria: JSON.stringify(qDetail.successCriteria ?? []),
              tags: qDetail.tags ?? [],
              oracle,
              sponsorshipFloor,
              commitFee,
              voteFee,
              stakeFloor,
              stakeBasisPoints,
              fundingDeadline,
              noSolutionGracePeriod,
              token: pre.token.contractAddress as `0x${string}`,
              amount: amountWei,
              feeAmount: 0n,
              feeShareBps: amountWei > 0n ? feeShareBps : 0,
              feeShares: amountWei > 0n
                ? [{ recipient: platformFeeRecipient, basisPoints: 10000 }]
                : [],
              walletClient,
              privateKey,
            });
            await awaitReceipt(publicClient, result.txHash!);
            return {
              intentHash: result.intentHash,
              txHash: result.txHash!,
              mode: "sponsor" as const,
            };
          }

          // mode === "cosponsor". If the preflight was fetched with
          // actionType="sponsor" the dispatcher delegated to the same
          // FundPreflight handler — preflight.mode reflects chain
          // state and is the source of truth here.
          const result = await runCosponsorFlow({
            baseUrl: API_URL,
            bearerToken: bearer,
            signer: address,
            questionId: params.question_id,
            qid: pre.qid as `0x${string}`,
            nonce,
            expiresAt,
            forgeAddress: env.router,
            chainId: pre.chainId ?? CHAIN_ID,
            expectedIntentHash: requireExpectedIntentHash(pre, "cosponsor"),
            token: pre.token.contractAddress as `0x${string}`,
            amount: amountWei,
            feeAmount: 0n,
            feeShareBps: amountWei > 0n ? feeShareBps : 0,
            feeShares: amountWei > 0n
              ? [{ recipient: platformFeeRecipient, basisPoints: 10000 }]
              : [],
            walletClient,
            privateKey,
          });
          await awaitReceipt(publicClient, result.txHash!);
          return {
            intentHash: result.intentHash,
            txHash: result.txHash!,
            mode: "cosponsor" as const,
          };
        })();

        return {
          mode: fundResp.mode,
          intent_hash: fundResp.intentHash,
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
  "Claim your share of a SETTLED question's payout pool. Pass just question_id — the tool fetches your role + amount + Merkle proof from GET /v1/accounts/:address?include=claims (filtered to this question) and broadcasts Router.claim. Optional qid_hex/amount_wei/proof overrides exist for power-user paths (manual settlement outside the standard pipeline). Router verifies the proof against the stored root and transfers USDC on success.",
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
    // QP Stage 1 — boundary check. question_id is interpolated into
    // the accounts include-fetch URL; qid_hex / proof items become
    // calldata to Router.claim. Validating shape before use blocks
    // URL-path injection AND keeps malformed hex from triggering a
    // viem stack trace deep in the broadcast path.
    assertQuestionId(params.question_id);
    if (params.qid_hex !== undefined) assertBytes32(params.qid_hex, "qid_hex");
    if (params.proof !== undefined) {
      for (let i = 0; i < params.proof.length; i++) {
        assertBytes32(params.proof[i], `proof[${i}]`);
      }
    }
    if (params.amount_wei !== undefined && !/^[0-9]+$/.test(params.amount_wei)) {
      throw new StructuredMCPError({
        code: "STRUCTURED_INPUT_INVALID",
        message: `amount_wei=${JSON.stringify(params.amount_wei)} is not a non-negative integer string.`,
        action: "Pass amount_wei as a decimal integer string (token base units).",
      });
    }
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
      // Default path: pull the caller's claim set from
      // GET /v1/accounts/:address?include=claims and filter to the
      // requested question_id. The Round-3 account include flattens
      // the per-question claim docs (qid + role + amount + proof +
      // merkleRoot) so a single backend call serves every settled
      // claim the caller is entitled to.
      const account = (await apiCall(
        "GET",
        `/v1/accounts/${address}?include=claims`,
      )) as {
        claims?: Array<{
          questionId: string;
          qid: string | null;
          role: string;
          amount: string;
          proof: string[];
          merkleRoot: string | null;
        }>;
      };
      const claims = account.claims ?? [];
      const claim = claims.find((c) => c.questionId === params.question_id);

      if (!claim) {
        throw new StructuredMCPError({
          code: "NOT_PARTICIPANT",
          message: `Address ${address} has no claim row for question ${params.question_id}; nothing to claim.`,
          action:
            "Only sponsors, solvers, and voters of a settled question receive a claim row. Inspect the caller's settled participation via GET /v1/accounts/:address?include=claims,participating. If the question is unsettled, wait for SettlementPublished.",
          details: { address, questionId: params.question_id },
        });
      }
      if (!claim.qid) {
        throw new StructuredMCPError({
          code: "QUESTION_NOT_ON_CHAIN",
          message: `Question ${params.question_id} has no chain qid yet.`,
          action:
            "Round may not be funded on-chain. Inspect status via the hosted MCP (rezontree_questions_get_question); fund_question if a sponsor is needed.",
          details: { questionId: params.question_id },
        });
      }
      if (claim.role === "none") {
        throw new StructuredMCPError({
          code: "NOT_PARTICIPANT",
          message: `Address ${address} did not participate in question ${params.question_id}; nothing to claim.`,
          action:
            "Only sponsors, solvers, and voters of a settled question can claim. Check GET /v1/accounts/:address?include=participating for questions where you have a role.",
          details: { address, questionId: params.question_id },
        });
      }
      if (!claim.merkleRoot) {
        throw new StructuredMCPError({
          code: "ROUND_NOT_SETTLED",
          message: `Round for question ${params.question_id} is not yet settled on-chain — no merkleRoot persisted.`,
          action:
            "Wait for SettlementPublished, then retry claim_payout. Monitor via GET /v1/questions/:id?include=settlement.",
          details: { questionId: params.question_id },
        });
      }

      questionId = claim.qid as Hex;
      amountWei = parseUnits(claim.amount as `${number}`, 6); // USDC 6dp
      proof = claim.proof as Hex[];
      role = claim.role;
    }

    // Router enforces one claim per (qid, recipient) — a retry
    // reverts RouterAlreadyClaimed. The cache replays the original
    // tx_hash when the first call's response was lost in transit.
    //
    // Idempotency key includes a hash of the proof so power-user
    // overrides (different proof for the same qid+amount) don't
    // collide. The recipient is the agent's own wallet (the merkle
    // leaf is keccak256(qid, recipient, amount); no other recipient
    // would verify against the stored root).
    return withIdempotency(
      "claim_payout",
      {
        addr: address,
        qid: questionId,
        amount: amountWei.toString(),
        proofKey: proofFingerprint(proof),
      },
      async () => {
        const txHash = await broadcastClaim(walletClient, {
          forgeAddress: env.router,
          questionId,
          recipient: address,
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

// ── Wallet ───────────────────────────────────────────────────────────

// readOnChainBalances reads native ETH (gas) + USDC (protocol funds) directly
// from the chain. Used by `me` + `cold_start` so agents see real spendable
// balances on first call — the previous /v1/wallet/balance backend endpoint
// does not exist and silently returned null, leading agents to assume they
// were broke.
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

async function readOnChainBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  address: Address,
) {
  const [ethWei, usdcRaw] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>,
  ]);
  return {
    eth: {
      raw: ethWei.toString(),
      human: Number(formatUnits(ethWei, 18)).toFixed(6),
      note: "Gas balance. Need ~0.0001 ETH per protocol write tx.",
    },
    usdc: {
      raw: usdcRaw.toString(),
      human: Number(formatUnits(usdcRaw, 6)).toFixed(6),
      address: USDC_ADDRESS,
      note: "On-chain USDC. Spend it via post_question / fund_question / submit_solution / cast_vote.",
    },
  };
}

// get_usdc_balance reads the ERC-20 balanceOf directly from the chain.
// This is DIFFERENT from the hosted rezontree_accounts_list_transactions
// tool: the transactions endpoint reflects protocol-internal ledger
// entries only (funds that moved through RezonForge). A faucet-funded
// wallet with no protocol activity will show 0 in transactions but may
// have a positive on-chain balance here. Always check this first before
// concluding "insufficient balance".
server.tool(
  "get_usdc_balance",
  "Read the on-chain USDC balance for your agent wallet directly from the ERC-20 contract. Use this to check your spendable balance before funding a question. NOTE: this is the raw chain balance — funds received via testnet faucet, transfers, or prior round payouts all appear here. The hosted MCP rezontree_accounts_list_transactions tool tracks protocol-internal history only and may show 0 even when this balance is positive.",
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

// ── get_session_token — bridge for hosted MCP authentication ─────────
//
// The hosted MCP at /mcp requires a Bearer JWT. Agent hosts that
// connect directly to the hosted MCP need this token. The local MCP
// already performs WalletLoginIntent → JWT on first apiCall(); this
// tool exposes the cached JWT so the agent host can inject it into
// the Authorization header for hosted-MCP calls. The token has a
// 15-min TTL; call this tool again after ~14 min (or on 401) to
// refresh.
//
// The agent invokes this tool, reads `accessToken` from the result,
// and uses it as `Authorization: Bearer <accessToken>` when calling
// the hosted MCP. The local MCP refreshes its own copy via
// getAgentToken() on call (which checks the 30s lead margin).

server.tool(
  "get_session_token",
  "Get a fresh JWT bearer token for the hosted MCP at /mcp. Returns { accessToken, expiresAt }. Call this once at session start, store the token, and reuse it as `Authorization: Bearer <accessToken>` in every hosted-MCP request. On 401 (token expired after ~15 min), call this tool again to refresh. NOTE: this is the same wallet identity used by the local MCP's signing tools — hosted + local share one auth.",
  {},
  async () => {
    const accessToken = await getAgentToken();
    const expiresAtMs =
      cachedToken?.expiresAt ?? Date.now() + 15 * 60 * 1000;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              accessToken,
              expiresAt: Math.floor(expiresAtMs / 1000),
              ttlSeconds: Math.max(
                0,
                Math.floor((expiresAtMs - Date.now()) / 1000),
              ),
              note: "Call again on 401 or near the 15-min mark. Same wallet identity as local MCP signing tools.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─────────────────────────────────────────────────────────────────────
// COMPOSITE TOOLS — `rt` namespace simplification (#372)
//
// These wrap the existing primitives into single-call workflows so
// agents don't have to orchestrate create_question + fund_question
// (and risk leaving an orphaned draft when the second leg fails).
// Each composite injects the relevant advisory prompt scaffold so
// the agent has guidance baked in.
// ─────────────────────────────────────────────────────────────────────

import { loadPrompt } from "../../src/prompts/index.js";
import {
  ETH_FAUCETS,
  ethFaucetMessage,
  requestUSDC,
} from "../../src/faucet/circle.js";

// ── me — composite "what is my situation" ────────────────────────────

server.tool(
  "me",
  "Local orientation tool. Returns the agent's wallet address and on-chain USDC + ETH balances (read directly from the ERC-20 + RPC — these are the authoritative spendable numbers, not a backend cache). For protocol-side state (reputation profile, authored / solved / voted / claimable rollup) call the hosted MCP tools `rezontree_accounts_list_profile` and `rezontree_accounts_list_participating-questions` — they own those reads and stay current with backend wire-shape changes.",
  {},
  async () => {
    const { address, publicClient } = getClients();
    const balance = await readOnChainBalances(publicClient, address).catch(
      (e) => ({ error: e instanceof Error ? e.message : String(e) }),
    );
    const summary = {
      address,
      balance,
      hint: "Spendable funds shown above. For protocol state (reputation, participating questions, claimable amounts) call hosted-MCP `rezontree_accounts_list_profile` + `rezontree_accounts_list_participating-questions`. To take action: post_question / submit_solution / cast_vote / claim_payout.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  },
);

// ── post_question — atomic create + sponsor ──────────────────────────

server.tool(
  "post_question",
  "Composite: scaffolds + creates + sponsors a question on-chain in one call. Replaces the create_question → fund_question 2-step that risked leaving orphaned drafts. Injects the post_question_scaffold + weight_guidance advisory prompts.",
  {
    title: z.string().describe("≤ 100 chars. Decision being made, not just topic."),
    description: z.string().describe("≥ 1000 chars. See post_question_scaffold.md."),
    bounty_usd: z
      .string()
      .describe("USDC bounty (e.g. '5.00'). Min 1.00 for sponsor."),
    voting_deadline: z
      .string()
      .describe("ISO 8601, default 48h from now."),
    success_criteria: z
      .array(
        z.object({
          name: z.string(),
          type: z.enum(["numeric", "boolean", "checklist"]),
          target: z.string(),
          weight: z.number(),
          unit: z.string().optional(),
        }),
      )
      .describe("Exactly 3, weights sum to 100. See weight_guidance.md."),
    assumptions: z
      .array(
        z.object({
          claim: z.string(),
          status: z.enum(["fixed", "challengeable"]),
        }),
      )
      .optional(),
    context: z.string().optional(),
    example: z.string().optional(),
    scope: z.string().optional(),
    tags: z
      .array(z.string())
      .min(3, "Provide 3-5 lowercase tags so the question is discoverable.")
      .max(5)
      .describe(
        "3-5 lowercase tags (e.g. ['btc', 'fibonacci', 'rsi']). Topic-specific, not generic ('ai', 'question'). Drives discovery + cross-question clustering for voters.",
      ),
  },
  async (params) => {
    // QP Stage 1 — boundary check. voting_deadline is passed via
    // `new Date(...)`. If the input is malformed we'd ship NaN
    // downstream and the backend rejects with an opaque validation
    // failure. Loud-fail here so the agent learns the shape.
    const deadlineMs = new Date(params.voting_deadline).getTime();
    if (!Number.isFinite(deadlineMs)) {
      throw new StructuredMCPError({
        code: "STRUCTURED_INPUT_INVALID",
        message: `voting_deadline=${JSON.stringify(params.voting_deadline)} is not a parseable ISO-8601 date.`,
        action:
          "Pass voting_deadline as ISO-8601, e.g. '2026-06-01T12:00:00Z'. Must be in the future.",
      });
    }
    const env = requireRouterEnv();
    const { walletClient, publicClient, privateKey, address } = getClients();

    return withIdempotency(
      "post_question",
      { addr: address, title: params.title, bounty: params.bounty_usd },
      async () => {
        // Step 1 — create question (off-chain row, status=draft).
        // Wire field is `initialBounty` in token base units (NOT `bountyAmount`,
        // and NOT a USD float). USDC has 6 decimals so $5 = "5000000".
        const decimals = 6; // USDC; preflight will return real decimals on step 2
        const initialBountyBase =
          parseAmountToWei(params.bounty_usd, decimals).toString();

        // Pre-flight balance check happens BEFORE creating the draft row so a
        // short wallet doesn't leave an orphan draft behind.
        await assertSpendableUSDC(
          publicClient,
          address,
          BigInt(initialBountyBase),
          "post_question",
        );

        const created = (await apiCall("POST", "/v1/questions", {
          title: params.title,
          description: params.description,
          initialBounty: initialBountyBase,
          bountyCurrency: "USD",
          // R-WIRE-ABSOLUTE-UNIX: backend expects int64 Unix seconds, not ISO-8601.
          // deadlineMs was validated at tool entry (Number.isFinite gate).
          votingDeadline: Math.floor(deadlineMs / 1000),
          successCriteria: params.success_criteria,
          assumptions: params.assumptions ?? [],
          context: params.context,
          example: params.example,
          scope: params.scope,
          tags: params.tags ?? [],
        })) as { id: string; qid: string };

        // Steps 2-5 are wrapped: if any leg fails the draft row created
        // in step 1 is left behind (no DELETE /v1/questions/:id exists
        // yet). We re-throw a structured error pointing the caller at
        // fund_question(question_id) to retry the sponsor leg without
        // re-running step 1.
        try {
          // Step 2 — sponsor preflight (Round-3 unified surface).
          const pre = (await apiCall(
            "POST",
            `/v1/questions/${created.id}/intents/preflight?sponsor=${address}`,
            { actionType: "sponsor", params: { sponsor: address } },
          )) as FundPreflight;
          if (pre.mode !== "sponsor") {
            throw new StructuredMCPError({
              code: "STALE_DRAFT_ROW",
              message: `post_question: preflight returned mode=${pre.mode} on a freshly-created question; expected mode=sponsor.`,
              action:
                "Likely a stale draft row from a prior run. Re-run post_question; if persistent, file a backend bug with the question id.",
              details: { questionId: created.id, mode: pre.mode },
            });
          }

          // Step 3 — balance + allowance gates. BountyForge uses
          // safeTransferFrom (no inline EIP-2612 permit); ensure the
          // wallet has approved the forge address.
          const amountWei = parseAmountToWei(
            params.bounty_usd,
            pre.token.decimals,
          );
          await ensureUsdcCoverage(
            publicClient,
            walletClient,
            address,
            amountWei,
            "post_question",
            env.router,
            null,
          );

          // Step 4 + 5 — single helper: builds witness, builds envelope,
          // signs, POSTs /v1/quadphase/submit, then broadcasts
          // sponsorSubmit(env, sig, witnessBytes) to the chain.
          const bearer = await getAgentToken();
          const sponsorshipFloor = BigInt(
            pre.sponsorshipFloor ?? pre.recommendedSponsorshipFloor ?? "0",
          );
          const commitFee = BigInt(pre.commitFee ?? "0");
          const voteFee = BigInt(pre.voteFee ?? "0");
          const stakeFloor = BigInt(pre.stakeFloor ?? "0");
          const stakeBasisPoints = Number(pre.stakeBasisPoints ?? "0");
          const noSolutionGracePeriod = BigInt(
            pre.noSolutionGracePeriod ?? "86400",
          );
          const fundingDeadline = BigInt(
            pre.recommendedFundingDeadline ??
              Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          );
          const feeShareBps = Number(pre.feeShareBps ?? "0");
          const platformFeeRecipient = resolvePlatformFeeRecipient(pre);
          const expiresAt = BigInt(
            pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300,
          );
          const nonce = BigInt(pre.nonce ?? "0");
          const oracle =
            (pre.oracle as `0x${string}` | undefined) ?? address;

          const result = await runSponsorFlow({
            baseUrl: API_URL,
            bearerToken: bearer,
            signer: address,
            questionId: created.id,
            qid: pre.qid as `0x${string}`,
            nonce,
            expiresAt,
            forgeAddress: env.router,
            chainId: pre.chainId ?? CHAIN_ID,
            expectedIntentHash: requireExpectedIntentHash(pre, "sponsor"),
            // Sponsor witness fields. Title + body are bound on-chain via
            // contentHash so the chain can attest content immutability.
            title: params.title,
            body: params.description,
            criteria: JSON.stringify(params.success_criteria),
            tags: params.tags ?? [],
            oracle,
            sponsorshipFloor,
            commitFee,
            voteFee,
            stakeFloor,
            stakeBasisPoints,
            fundingDeadline,
            noSolutionGracePeriod,
            // Funds the sponsor envelope binds.
            token: pre.token.contractAddress as `0x${string}`,
            amount: amountWei,
            feeAmount: 0n,
            feeShareBps,
            feeShares: [
              { recipient: platformFeeRecipient, basisPoints: 10000 },
            ],
            walletClient,
            privateKey,
          });
          await awaitReceipt(publicClient, result.txHash!);

          return {
            question_id: created.id,
            qid: created.qid,
            intent_hash: result.intentHash,
            sponsor_tx_hash: result.txHash,
            chain_pool_amount: amountWei.toString(),
            status: "sponsored",
            note: "Backend reconciler flips status draft→open + populates chain_pool_amount within 1 tick (~5s). Re-fetch via the hosted MCP (rezontree_questions_get_question) to confirm.",
          };
        } catch (err) {
          const originalError =
            err instanceof StructuredMCPError
              ? {
                  code: err.code,
                  message: err.message,
                  action: err.action,
                  requestId: err.requestId,
                  details: err.details,
                }
              : err instanceof Error
                ? { message: err.message }
                : { message: String(err) };
          throw new StructuredMCPError({
            code: "POST_QUESTION_SPONSOR_FAILED",
            message: `post_question: question row was created (id=${created.id}) but the sponsor leg failed. The draft is orphaned until you retry the sponsor leg or it ages out.`,
            action: `Retry the sponsor leg with: fund_question { question_id: "${created.id}", amount: "${params.bounty_usd}" }. Do NOT re-call post_question — that creates a duplicate draft.`,
            details: {
              questionId: created.id,
              qid: created.qid,
              originalError,
            },
          });
        }
      },
    );
  },
);

// ── wait_for_questions — long-poll for new actionable questions ─────
//
// Closes the swarm "empty pond" failure mode (mega25 retro, May 17):
// when N solvers boot simultaneously and the backend is empty for the
// first 90-120s (questioners haven't sponsored yet, or Ponder is still
// reconciling), agents who polled once and exited burned $0.60 each
// for zero work. This tool wraps that wait. One MCP call → one
// poll-cycle. Returns as soon as new (unseen, action-eligible)
// questions show up, OR when `max_wait_seconds` elapses, whichever
// first.
//
// Process-level memory of "seen" question IDs lets repeated calls
// return only the *new* set since the last call. Reset by restarting
// the MCP server (e.g. between agent sessions).
//
// Reads via the same authenticated apiCall path as everything else,
// so JWT refresh + 401 retry stay in play. No special-case caching.

// Bounded "seen" set — a long-running solver agent that polls every 60s
// for a week would otherwise accumulate ~10k IDs and grow without bound
// (audit #617). Cap at 5000 most-recent IDs; on overflow we drop the
// oldest entry. Set iteration is insertion order, so .values().next()
// gives us the eviction target. Threat model: memory exhaustion of the
// MCP host process from a multi-day agent run.
const SEEN_QUESTION_IDS_MAX = 5000;
const seenQuestionIds = new Set<string>();

function rememberSeenQuestion(id: string): void {
  if (seenQuestionIds.has(id)) {
    // Refresh recency by re-inserting (delete + add keeps it newest).
    seenQuestionIds.delete(id);
    seenQuestionIds.add(id);
    return;
  }
  seenQuestionIds.add(id);
  while (seenQuestionIds.size > SEEN_QUESTION_IDS_MAX) {
    const oldest = seenQuestionIds.values().next().value;
    if (oldest === undefined) break;
    seenQuestionIds.delete(oldest);
  }
}

// QuestionRow — the subset of the Round-3 QuestionResponse fields this
// tool reads. Producer is `internal/handler/question.go` (struct
// `QuestionResponse` for full view + `QuestionCardResponse` for compact);
// both emit camelCase `id` and `authorAddress`. The pre-Round-3 fallback
// shape (`questionId`, `author_address`) was retired upstream — dead-
// branch reads removed here per audit drift-2026-05-21 §03 to avoid
// silently accepting an obsolete shape.
interface QuestionRow {
  id?: string;
  title?: string;
  status?: string;
  tags?: string[];
  authorAddress?: string;
  createdAt?: number;
}

server.tool(
  "wait_for_questions",
  "Long-poll the backend's question list and return as soon as new (unseen, action-eligible) questions appear. Designed to replace the swarm 'poll once and exit' anti-pattern that crashes when the question pool is empty for the first 60-120s of a run. Default cadence: 60s poll interval, 1800s (30min) max wait. Tracks 'seen' question IDs across calls in this MCP process — repeated invocations only return the new set since last call. Filter by `tags` (any-match) or `exclude_authors` (avoid your own questions). Returns immediately on first call if questions already exist. On timeout: returns { matched: [], waited: <seconds>, hint: 'no questions matched within deadline; widen tags or accept current empty state' }.",
  {
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Lowercase tag(s) to filter on (any-match). Omit or empty array = match all open questions.",
      ),
    exclude_authors: z
      .array(z.string())
      .optional()
      .describe(
        "0x-prefixed author addresses to filter out (e.g. your own wallet so you don't try to solve your own questions). Case-insensitive.",
      ),
    poll_interval_seconds: z
      .number()
      .int()
      .min(15)
      .max(900)
      .optional()
      .describe(
        "Seconds between successive list_questions calls. Default 60 in testing, 300 in prod. Floor 15 prevents accidental DOS.",
      ),
    max_wait_seconds: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe(
        "Hard ceiling on this tool call's wall-clock wait. Default 1800 (30 min). Set lower if your agent budget is tight.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max questions per list_questions call. Default 20."),
  },
  async (params) => {
    const pollMs = (params.poll_interval_seconds ?? 60) * 1000;
    const maxMs = (params.max_wait_seconds ?? 1800) * 1000;
    const limit = params.limit ?? 20;
    // Validate exclude_authors at the boundary — agent-supplied
    // strings shouldn't bypass shape checks just because they go to
    // a local Set rather than a URL.
    for (const a of params.exclude_authors ?? []) {
      assertAddress(a, "exclude_authors[]");
    }
    const wantTags = (params.tags ?? []).map((t) => t.toLowerCase());
    const excludeAuthors = new Set(
      (params.exclude_authors ?? []).map((a) => a.toLowerCase()),
    );
    const deadline = Date.now() + maxMs;
    let attempts = 0;

    while (true) {
      attempts++;
      // Canonical Round-3 sort values for GET /v1/questions:
      // `created_at` (default — newest first), `initial_bounty`,
      // `solution_count`. See `internal/handler/question.go` validation
      // switch. The historical bug (#616 / audit drift-2026-05-21) was
      // `created_at:desc` with a `:desc` suffix the backend 400s on.
      // We pass `created_at` explicitly so the URL reads as a contract
      // rather than relying on server-side defaults.
      const path =
        `/v1/questions?status=open&sort=created_at&limit=${limit}`;
      let raw: unknown;
      try {
        raw = await apiCall("GET", path);
      } catch (err) {
        // Surface auth / network errors directly — they're not flaky.
        // R-AGENT-OP-ERGONOMICS: tell the agent what to do next instead
        // of swallowing it.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: "list_failed",
                  reason: msg,
                  action:
                    "Inspect the error envelope above. If it's an UNAUTHORIZED, call this tool again (the next attempt re-auths). For other errors, fix and retry.",
                  attempts,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Round-3 list shape is `{data: T[], cursor?, hasMore}` (see
      // `handler.PagedList[QuestionResponse]`). The pre-Round-3 `items?`
      // probe + bare-array fallback were dead code per audit
      // drift-2026-05-21 §03 — removed so a future producer that drifts
      // to an unrelated shape surfaces an empty match (and the agent
      // re-tries) instead of silently reading `undefined` keys.
      const list =
        (raw as { data?: QuestionRow[] }).data ??
        ([] as QuestionRow[]);

      const matched: QuestionRow[] = [];
      for (const q of list) {
        const qid = q.id;
        if (!qid) continue;
        if (seenQuestionIds.has(qid)) continue; // already returned to caller
        const author = (q.authorAddress ?? "").toLowerCase();
        if (author && excludeAuthors.has(author)) {
          // Mark as seen so we never bother the caller with it again.
          rememberSeenQuestion(qid);
          continue;
        }
        if (wantTags.length > 0) {
          const qTags = (q.tags ?? []).map((t) => t.toLowerCase());
          if (!qTags.some((t) => wantTags.includes(t))) {
            // Not a tag match — leave unseen (might match a future call
            // with different tags).
            continue;
          }
        }
        matched.push(q);
        rememberSeenQuestion(qid);
      }

      if (matched.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  matched: matched.map((q) => ({
                    id: q.id,
                    title: q.title,
                    tags: q.tags,
                    authorAddress: q.authorAddress,
                    status: q.status,
                    createdAt: q.createdAt,
                  })),
                  matchedCount: matched.length,
                  attempts,
                  waitedMs: Date.now() - (deadline - maxMs),
                  hint:
                    "Returned the new questions. Call this tool again later to wait for the next batch. Process-level 'seen' set will deduplicate.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  matched: [],
                  matchedCount: 0,
                  attempts,
                  waitedMs: maxMs,
                  hint:
                    "No new matching questions before deadline. Either widen `tags`, raise `max_wait_seconds`, or accept the empty pond — there may genuinely be no actionable work right now.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      // Sleep min(pollMs, remainingMs) so we don't overshoot the deadline.
      await new Promise((r) => setTimeout(r, Math.min(pollMs, remainingMs)));
    }
  },
);

// ── wait_for_chain_confirmation — block until reconciler confirms ────
//
// Closes #616's third agent-friction item: after a sign + broadcast
// flow (submit_solution, cast_vote, fund_question, claim_payout) the
// agent holds an `intent_hash` but can't tell when the backend's
// reconciler has caught up with Ponder's chain ingest. Pre-fix, agents
// hand-rolled a poll loop over GET /v1/accounts/me?include=pending,
// often with wrong intervals or no rejection check — burning budget
// or shipping follow-up actions on an unconfirmed row.
//
// Mechanism. Pending intents (`signed_intents.status='pending'`) surface
// on /v1/accounts/me?include=pending with `intentHash` + `lifecyclePhase`.
// The reconciler flips the row to terminal state when Ponder's chain-
// event projector reports the broadcast tx. Two terminal outcomes:
//   • confirmed → row drops off the pending list (status='confirmed').
//   • rejected_revalidation → row stays but `lifecyclePhase` populates.
//     Stage-4 caught a chain-event ↔ intent_hash mismatch; retrying
//     the same intent will fail again. The tool surfaces this as
//     WAIT_CONFIRMATION_REJECTED so the agent stops the flow.
//
// Why poll /accounts/me + filter client-side rather than a per-hash
// endpoint? Round-3's 14-endpoint contract has no GET-by-intent-hash
// surface (R-API-ROUND3-CONSOLIDATE-BEFORE-ADD), and adding one for a
// progress check would be exactly the kind of bespoke read the rule
// targets. The pending list is already authoritative — the agent owns
// the intent_hash → membership test is O(N) where N is the caller's
// pending count (single-digit in practice).

interface PendingIntentItem {
  intentHash?: string;
  questionId?: string;
  chainId?: number;
  status?: string;
  lifecyclePhase?: string;
  lifecycleReason?: string;
  createdAt?: number;
  updatedAt?: number;
}

server.tool(
  "wait_for_chain_confirmation",
  "Block until the reconciler confirms (or rejects) a chain-bound intent the agent just broadcast. Pass `intent_hash` (the 0x-prefixed bytes32 returned by submit_solution / cast_vote / fund_question / claim_payout). Polls /v1/accounts/me?include=pending until the intent leaves the pending list (confirmed) or its lifecyclePhase flips to 'rejected_revalidation' (Stage-4 reject — same intent will never confirm). Defaults: 2s poll, 60s timeout. Errors: WAIT_CONFIRMATION_TIMEOUT (deadline elapsed, intent still pending — try again with longer max_wait_seconds, or check the chain manually), WAIT_CONFIRMATION_REJECTED (chain event ↔ intent mismatch; do NOT retry the same intent).",
  {
    intent_hash: z
      .string()
      .describe(
        "0x-prefixed bytes32 intent hash returned by the chain-bound tool that broadcast this intent.",
      ),
    poll_interval_seconds: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe(
        "Seconds between successive /accounts/me?include=pending polls. Default 2.",
      ),
    max_wait_seconds: z
      .number()
      .int()
      .min(5)
      .max(600)
      .optional()
      .describe(
        "Hard ceiling on this tool call's wall-clock wait. Default 60 (covers Base Sepolia 12s finality + reconciler lag with margin).",
      ),
  },
  async (params) => {
    assertBytes32(params.intent_hash, "intent_hash");
    const intentHash = params.intent_hash.toLowerCase();
    const pollMs = (params.poll_interval_seconds ?? 2) * 1000;
    const maxMs = (params.max_wait_seconds ?? 60) * 1000;
    const startedAt = Date.now();
    const deadline = startedAt + maxMs;
    let attempts = 0;
    let lastSeenItem: PendingIntentItem | undefined;

    // Single helper: one /accounts/me?include=pending fetch + filter for
    // the caller-owned row whose intentHash matches. Returns null when
    // the hash is no longer in the pending list — interpreted by the
    // caller as "reconciler confirmed (or never staged it; see hint)".
    async function findPendingRow(): Promise<PendingIntentItem | null> {
      // Round-3 surfaces /v1/me/pending via /v1/accounts/me?include=pending.
      // The local-MCP drift fence (server.test.ts ALLOWED_API_PATHS)
      // already accepts /v1/accounts/[^/]+ so this stays in-bounds.
      const raw = (await apiCall(
        "GET",
        "/v1/accounts/me?include=pending",
      )) as { pending?: { intents?: PendingIntentItem[] } };
      const intents = raw?.pending?.intents ?? [];
      for (const it of intents) {
        if ((it.intentHash ?? "").toLowerCase() === intentHash) return it;
      }
      return null;
    }

    while (true) {
      attempts++;
      const found = await findPendingRow();

      if (found === null) {
        // Two indistinguishable cases on the wire:
        //   (a) reconciler flipped status='confirmed' (most common — the
        //       happy path the agent waited for), OR
        //   (b) the backend never staged a pending row for this hash
        //       (the broadcast happened but the POST signed-envelope
        //       step was skipped — operator error).
        // The hint covers (b) so an agent that miswired the flow can
        // diagnose without us inventing a per-hash endpoint.
        return {
          content: [
            {
              type: "text",
              text: safeJSONStringify({
                ok: true,
                confirmed: true,
                intentHash,
                attempts,
                waitedMs: Date.now() - startedAt,
                hint:
                  "Intent no longer in pending list — either Stage-4 confirmed it (happy path) or no pending row ever existed for this hash (skipped /intents POST). To inspect confirmed surface, query the parent resource (e.g. GET /v1/questions/<questionId> for sponsor/commit/vote effects).",
              }),
            },
          ],
        };
      }

      lastSeenItem = found;

      // Stage-4 hard reject: reconciler recomputed intent_hash from
      // event params and it didn't match the staged row's hash (see
      // R-CHAIN-VERIFIES-INTENT). Retrying the same intent is pointless
      // — surface as a non-retryable error so the agent stops the flow.
      if (found.lifecyclePhase === "rejected_revalidation") {
        throw new StructuredMCPError({
          code: "WAIT_CONFIRMATION_REJECTED",
          message: `Intent ${intentHash} was rejected by Stage-4 revalidation: ${
            found.lifecycleReason ?? "(no reason provided)"
          }.`,
          action:
            "Do NOT retry this intent. The chain-emitted event params didn't match the signed envelope's hash, so the reconciler will never confirm it. Inspect the broadcast tx on-chain, then construct a fresh preflight + sign + POST cycle if you still want the action.",
          details: {
            intentHash,
            lifecyclePhase: found.lifecyclePhase,
            lifecycleReason: found.lifecycleReason ?? null,
            questionId: found.questionId ?? null,
            chainId: found.chainId ?? null,
          },
        });
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        // Timeout: still pending. Could be Base Sepolia finality lag,
        // Ponder behind, or just a slow chain. Surface as retryable so
        // the agent can call us again with a fresh deadline.
        throw new StructuredMCPError({
          code: "WAIT_CONFIRMATION_TIMEOUT",
          message: `Intent ${intentHash} still pending after ${
            Math.round(maxMs / 1000)
          }s (${attempts} polls).`,
          action:
            "Call wait_for_chain_confirmation again with a larger max_wait_seconds, or check Ponder lag via the backend's /metrics. If the broadcast tx itself is on-chain but the reconciler hasn't projected it after several minutes, file a backend incident — don't re-broadcast.",
          details: {
            intentHash,
            attempts,
            waitedMs: Date.now() - startedAt,
            lastSeen: lastSeenItem,
          },
          retryable: true,
        });
      }
      await new Promise((r) => setTimeout(r, Math.min(pollMs, remainingMs)));
    }
  },
);

// ── wallet_topup_faucet — one-shot Circle USDC faucet ────────────────

server.tool(
  "wallet_topup_faucet",
  "Testnet only. Requests USDC from Circle's Base Sepolia faucet for the given address (defaults to current agent's). Also returns ETH faucet links since Circle doesn't dispatch ETH for gas.",
  {
    address: z
      .string()
      .optional()
      .describe("0x address. Defaults to current agent's wallet."),
  },
  async (params) => {
    const target = params.address ?? getClients().address;
    // Boundary check — the faucet helper interpolates target into a
    // Circle API URL; defend against URL-segment injection.
    assertAddress(target, "address");
    const result = await requestUSDC(target);
    const eth_hint = ethFaucetMessage(target);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...result, eth_hint, eth_faucets: ETH_FAUCETS }, null, 2),
        },
      ],
    };
  },
);

// ── cold_start — return the orientation prompt + a `me` snapshot ────

server.tool(
  "cold_start",
  "First call for a fresh agent session. Returns the cold_start advisory prompt bundled with wallet address, on-chain USDC + ETH balance, and current UTC time. Use balance.usdc.human + balance.eth.human to decide whether to proceed or faucet — these are real on-chain numbers. For your reputation profile + protocol-side history, follow up with hosted MCP `rezontree_accounts_list_profile`.",
  {},
  async () => {
    const { address, publicClient } = getClients();
    const balance = await readOnChainBalances(publicClient, address).catch(
      (e) => ({ error: e instanceof Error ? e.message : String(e) }),
    );
    const now = new Date();
    const currentUtcIso = now.toISOString();
    const currentEpochSec = Math.floor(now.getTime() / 1000);
    const text = `${loadPrompt("cold_start")}\n\n---\n\n## Your situation\n\n${JSON.stringify(
      { address, currentUtcIso, currentEpochSec, balance },
      null,
      2,
    )}`;
    return { content: [{ type: "text", text }] };
  },
);

// ── Methodology / craft tools ────────────────────────────────────────
//
// These do not call backend or chain — they return STABLE craft guidance
// that helps an agent be a better RezonAgent. Per the hosted-MCP-first
// architecture, all backend-wire-shape tools have moved to the hosted MCP
// at `http://localhost:8080/mcp`; this local MCP keeps wallet + sign +
// broadcast + methodology only.

import { methodologyTools } from "../../src/methodology/index.js";

// Collapse N craft_* advisories into a single tool with a topic enum.
// Tool count matters: every tool in the listing competes for the
// agent's selection probability and dilutes focus on the action tools
// (submit_solution / cast_vote / fund_question / claim_payout /
// post_question / wait_for_questions). Advisories are pure text — they
// don't need their own slot. Agents reach for them by topic, not by
// name discovery.
const adviceTopics = methodologyTools.map((t) => t.name);
const adviceByTopic: Record<string, () => string> = Object.fromEntries(
  methodologyTools.map((t) => [t.name, t.body]),
);
server.tool(
  "get_craft_advice",
  `Static craft / methodology guidance — call with a topic. Returns the relevant advisory body. Topics:\n${methodologyTools
    .map((t) => `  • ${t.name}: ${t.description}`)
    .join("\n")}`,
  {
    topic: z
      .enum(adviceTopics as [string, ...string[]])
      .describe("Which advisory to load."),
  },
  async (params) => {
    const body = adviceByTopic[params.topic]?.() ?? "(topic not found)";
    return { content: [{ type: "text", text: body }] };
  },
);

// ── Start Server ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
