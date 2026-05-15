// modules/wallets/referral.ts — affiliate-referrer attribution helper.
//
// Wires the SDK-side handshake for `POST /v1/me/referrer`. When a new
// wallet is registered with an optional referral code, this module:
//
//   1. Signs an EIP-712 WalletLoginIntent using the wallet's viem
//      Account (works for HD, imported, and Privy provider types).
//   2. POSTs /auth/wallet to obtain a JWT bearer token.
//   3. POSTs /v1/me/referrer { code } to bind the referrer.
//
// The flow is **best-effort and non-blocking** — every error is
// logged at warn-level and returned in the result, but the caller
// (typically `wallets register`) continues regardless. A failed
// referral attribution does not undo a successful local wallet
// registration: the local DB is authoritative for "this wallet
// exists in my SDK," the backend is authoritative for "this wallet
// is bound to a referrer."
//
// Backend contract (migration 0008):
//   - 24h grace from accounts.created_at; past that → REFERRAL_GRACE_EXPIRED.
//   - One-shot: subsequent calls → REFERRER_ALREADY_SET.
//   - Self-referral block: code resolves to caller wallet → REFERRER_SELF.
//   - Unknown code → REFERRAL_CODE_NOT_FOUND.

import type { Account, Address, TypedDataDomain } from "viem";

import {
  DEFAULT_LOGIN_DOMAIN,
  loadLoginDomain,
  WALLET_LOGIN_INTENT_TYPES,
} from "../../wallet/domain.js";

export interface ApplyReferralCodeArgs {
  /** The viem Account whose wallet is being attributed to a referrer. */
  account: Account;
  /** The 5-char [a-z0-9] referral code, case-insensitive on input. */
  code: string;
  /** Backend base URL (e.g. https://api.rezontree.com). */
  backendUrl: string;
}

export type ApplyReferralCodeResult =
  | { ok: true; referrerWallet: Address; setAt: number }
  | { ok: false; code: string; message: string; action?: string };

/**
 * Sign-in, then POST /v1/me/referrer with the given code.
 *
 * Never throws — all failures are returned as `{ ok: false, ... }`.
 * The caller's responsibility is to surface the failure (log + UI
 * message) without aborting the parent operation.
 */
export async function applyReferralCode(
  args: ApplyReferralCodeArgs,
): Promise<ApplyReferralCodeResult> {
  const normalized = args.code.trim().toLowerCase();
  // Client-side format gate only. The backend additionally rejects
  // codes that match programmatic blocklist rules (all-digits, "rzn"
  // prefix, all-same-char) plus a curated reserved list — those
  // rejections surface as REFERRAL_CODE_RESERVED on the wire, NOT as
  // REFERRAL_CODE_INVALID_FORMAT. The server is authoritative.
  if (!/^[a-z0-9]{5}$/.test(normalized)) {
    return {
      ok: false,
      code: "REFERRAL_CODE_INVALID_FORMAT",
      message: `Referral code must be 5 chars [a-z0-9] (got "${args.code}").`,
      action: "Fix the code (5 chars, lowercase a-z or 0-9, no punctuation) and retry the wallet register command.",
    };
  }

  // 1+2. Sign-in.
  const auth = await authenticateWallet(args.account, args.backendUrl);
  if (!auth.ok) return auth;
  const { token, baseUrl } = auth;

  // 3. POST /v1/me/referrer.
  try {
    const resp = await fetch(`${baseUrl}/v1/me/referrer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: normalized }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await resp.json()) as {
      referrerWallet?: Address;
      setAt?: number;
      error?: { code?: string; message?: string; action?: string };
    };
    if (!resp.ok) {
      return {
        ok: false,
        code: body.error?.code ?? `HTTP_${resp.status}`,
        message: body.error?.message ?? `set-referrer returned ${resp.status}`,
        action: body.error?.action,
      };
    }
    if (body.referrerWallet == null || body.setAt == null) {
      return {
        ok: false,
        code: "MALFORMED_RESPONSE",
        message: "set-referrer response missing required fields.",
      };
    }
    return {
      ok: true,
      referrerWallet: body.referrerWallet,
      setAt: body.setAt,
    };
  } catch (err) {
    return {
      ok: false,
      code: "REFERRER_NETWORK_ERROR",
      message: `Network error against ${baseUrl}/v1/me/referrer: ${errMsg(err)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// AFFILIATE-SIDE: claim / view / upgrade YOUR OWN referral code.
// ─────────────────────────────────────────────────────────────────────

/**
 * Affiliate-side: the wallet's own referral code (the one OTHERS use
 * to credit this wallet as their referrer). All three functions
 * below share this result shape.
 *
 * - `url` is the canonical shareable link when the backend has
 *   RT_PUBLIC_BASE_URL configured. Omitted otherwise.
 * - `canUpgrade` is true iff the one-shot auto_generated → user_chosen
 *   upgrade is still available. The backend collapses the internal
 *   (source, status) taxonomy into this single bit so clients never
 *   see the lifecycle enums.
 */
export type MyReferralCodeResult =
  | {
      ok: true;
      code: string;
      walletAddress: Address;
      url?: string;
      canUpgrade: boolean;
      createdAt: number;
      createdNew?: boolean; // true on POST first-claim, false/undefined on idempotent re-call
    }
  | { ok: false; code: string; message: string; action?: string };

interface AffiliateOpArgs {
  account: Account;
  backendUrl: string;
}

/**
 * GET /v1/me/referral-code — read the wallet's current code.
 * Returns `REFERRAL_CODE_NOT_FOUND` (404) when nothing claimed yet.
 */
export async function getMyReferralCode(
  args: AffiliateOpArgs,
): Promise<MyReferralCodeResult> {
  return await affiliateCodeOp({
    ...args,
    method: "GET",
    body: undefined,
  });
}

/**
 * POST /v1/me/referral-code — idempotent get-or-create.
 *
 * - `desiredCode == undefined` → auto-generate.
 * - `desiredCode == "rezon"` → claim that code (after format + reserved
 *   validation).
 *
 * Returns the existing row on idempotent re-call (createdNew=false).
 */
export async function claimMyReferralCode(
  args: AffiliateOpArgs & { desiredCode?: string },
): Promise<MyReferralCodeResult> {
  const body: Record<string, string> = {};
  if (args.desiredCode !== undefined) {
    const normalized = args.desiredCode.trim().toLowerCase();
    if (!/^[a-z0-9]{5}$/.test(normalized)) {
      return {
        ok: false,
        code: "REFERRAL_CODE_INVALID_FORMAT",
        message: `Referral code must be 5 chars [a-z0-9] (got "${args.desiredCode}").`,
      };
    }
    body.desiredCode = normalized;
  }
  return await affiliateCodeOp({
    account: args.account,
    backendUrl: args.backendUrl,
    method: "POST",
    body,
  });
}

/**
 * PATCH /v1/me/referral-code — one-shot upgrade auto-generated → user_chosen.
 *
 * Backend enforces the one-shot rule: a code that's already been
 * upgraded returns REFERRAL_CODE_LOCKED. Check `canUpgrade` on the
 * current row to know whether the upgrade is still available before
 * calling.
 */
export async function upgradeMyReferralCode(
  args: AffiliateOpArgs & { desiredCode: string },
): Promise<MyReferralCodeResult> {
  const normalized = args.desiredCode.trim().toLowerCase();
  if (!/^[a-z0-9]{5}$/.test(normalized)) {
    return {
      ok: false,
      code: "REFERRAL_CODE_INVALID_FORMAT",
      message: `Referral code must be 5 chars [a-z0-9] (got "${args.desiredCode}").`,
    };
  }
  return await affiliateCodeOp({
    account: args.account,
    backendUrl: args.backendUrl,
    method: "PATCH",
    body: { desiredCode: normalized },
  });
}

/**
 * Internal shared implementation for the three affiliate-side verbs.
 * Auths, fires the request, normalizes the response into MyReferralCodeResult.
 */
async function affiliateCodeOp(args: {
  account: Account;
  backendUrl: string;
  method: "GET" | "POST" | "PATCH";
  body: Record<string, unknown> | undefined;
}): Promise<MyReferralCodeResult> {
  const auth = await authenticateWallet(args.account, args.backendUrl);
  if (!auth.ok) return auth;
  const { token, baseUrl } = auth;

  // Audit-fix M6: Content-Type only on requests that ship a body.
  // RFC 9110 discourages Content-Type on bodyless GETs and some strict
  // proxies (or future backend middleware) reject the combination.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (args.method !== "GET") {
    headers["Content-Type"] = "application/json";
  }

  try {
    const resp = await fetch(`${baseUrl}/v1/me/referral-code`, {
      method: args.method,
      headers,
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await resp.json()) as {
      code?: string;
      walletAddress?: Address;
      url?: string;
      canUpgrade?: boolean;
      createdAt?: number;
      error?: { code?: string; message?: string; action?: string };
    };
    if (!resp.ok) {
      return {
        ok: false,
        code: body.error?.code ?? `HTTP_${resp.status}`,
        message: body.error?.message ?? `referral-code ${args.method} returned ${resp.status}`,
        action: body.error?.action,
      };
    }
    // Audit-fix M1: explicit `== null` (which catches undefined + null
    // only) rather than falsy guards. `!body.code` would false-positive
    // on `""` and `!body.createdAt` would false-positive on `0`. Neither
    // value occurs in production (code is 5 chars, timestamp is post-1970),
    // but the guard's intent is "field absent" and that's what `== null` says.
    if (
      body.code == null ||
      body.walletAddress == null ||
      body.canUpgrade == null ||
      body.createdAt == null
    ) {
      return {
        ok: false,
        code: "MALFORMED_RESPONSE",
        message: "referral-code response missing required fields.",
      };
    }
    return {
      ok: true,
      code: body.code,
      walletAddress: body.walletAddress,
      url: body.url,
      canUpgrade: body.canUpgrade,
      createdAt: body.createdAt,
      createdNew: resp.status === 201,
    };
  } catch (err) {
    return {
      ok: false,
      code: "REFERRAL_NETWORK_ERROR",
      message: `Network error against ${baseUrl}/v1/me/referral-code: ${errMsg(err)}`,
    };
  }
}

// ── Internals ────────────────────────────────────────────────────────

// Token cache (audit-fix M2): in-process keyed on `${address}|${baseUrl}`.
// Backend access tokens expire in 15 minutes (CLAUDE.md: "Access tokens
// expire in 15 min"). We cache with a conservative 12-minute TTL so the
// token is still fresh when reused. Smart-wallet signers (Safe / Argent /
// 4337) pay 100-500ms per signTypedData via eth_call — without caching,
// the CLI flow `referral-code show → claim → upgrade` is 3 sequential
// signs. With caching, it's 1 sign + 2 token reuses.
const TOKEN_CACHE_TTL_MS = 12 * 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function tokenCacheKey(address: Address, baseUrl: string): string {
  return `${address.toLowerCase()}|${baseUrl}`;
}

/**
 * authenticateWallet signs an EIP-712 WalletLoginIntent with the
 * given viem Account, POSTs /auth/wallet, and returns either the
 * JWT bearer + normalized base URL on success, or a typed failure
 * shape compatible with both ApplyReferralCodeResult and
 * MyReferralCodeResult so callers can `return auth` on the unhappy path.
 *
 * Caches the bearer in-process for 12 minutes per (address, baseUrl)
 * pair — see TOKEN_CACHE_TTL_MS.
 */
async function authenticateWallet(
  account: Account,
  backendUrl: string,
): Promise<
  | { ok: true; token: string; baseUrl: string }
  | { ok: false; code: string; message: string; action?: string }
> {
  const baseUrl = backendUrl.replace(/\/+$/, "");

  // Check the cache first — saves a sign + an HTTP round-trip on the
  // hot path (multiple CLI invocations in one process, e.g. a test
  // script that calls show → upgrade → show).
  const cacheKey = tokenCacheKey(account.address, baseUrl);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, token: cached.token, baseUrl };
  }

  let signedLogin: SignedLoginBody;
  try {
    signedLogin = await signLogin(account);
  } catch (err) {
    return {
      ok: false,
      code: "SIGN_FAILED",
      message: `Failed to sign WalletLoginIntent: ${errMsg(err)}`,
    };
  }

  try {
    const resp = await fetch(`${baseUrl}/auth/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedLogin),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await resp.json()) as {
      accessToken?: string;
      error?: { code?: string; message?: string; action?: string };
    };
    if (!resp.ok || !body.accessToken) {
      return {
        ok: false,
        code: body.error?.code ?? `HTTP_${resp.status}`,
        message: body.error?.message ?? `auth/wallet returned ${resp.status}`,
        action: body.error?.action,
      };
    }
    tokenCache.set(cacheKey, {
      token: body.accessToken,
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
    });
    return { ok: true, token: body.accessToken, baseUrl };
  } catch (err) {
    return {
      ok: false,
      code: "AUTH_NETWORK_ERROR",
      message: `Network error against ${baseUrl}/auth/wallet: ${errMsg(err)}`,
    };
  }
}

interface SignedLoginBody {
  address: Address;
  chainId: number;
  expiresAt: number;
  signature: `0x${string}`;
}

async function signLogin(account: Account): Promise<SignedLoginBody> {
  // Resolve domain from env (RT_AGENT_DOMAIN_*) or fall back to default.
  // loadLoginDomain() reads process.env at call time, matching the
  // pattern used by preflight.ts and the runtime executors.
  const domain = (() => {
    try {
      return loadLoginDomain();
    } catch {
      return DEFAULT_LOGIN_DOMAIN;
    }
  })();

  const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 min freshness
  const message = {
    ethAddress: account.address,
    chainId: BigInt(domain.chainId),
    expiresAt: BigInt(expiresAt),
  };

  if (!account.signTypedData) {
    throw new Error(
      `Account ${account.address} does not support signTypedData — required for EIP-712 wallet login.`,
    );
  }

  const signature = await account.signTypedData({
    domain: toViemDomain(domain),
    types: WALLET_LOGIN_INTENT_TYPES,
    primaryType: "WalletLoginIntent",
    message,
  });

  return {
    address: account.address,
    chainId: domain.chainId,
    expiresAt,
    signature,
  };
}

function toViemDomain(d: ReturnType<typeof loadLoginDomain>): TypedDataDomain {
  return {
    name: d.name,
    version: d.version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a referral code from CLI flag with env var fallback.
 *
 * Priority: explicit flag > REZONTREE_REFERRAL_CODE env var > undefined.
 * Whitespace is trimmed; the empty string falls through to env. The
 * caller validates the format — this helper just resolves the source.
 */
export function resolveReferralCode(
  cliFlag: string | undefined,
): string | undefined {
  const fromFlag = cliFlag?.trim();
  if (fromFlag) return fromFlag;

  const fromEnv = process.env.REZONTREE_REFERRAL_CODE?.trim();
  if (fromEnv) return fromEnv;

  return undefined;
}
