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
  | { ok: true; referrerWallet: Address; setAt: number; graceExpiresAt: number }
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
      referrer_wallet?: Address;
      set_at?: number;
      grace_expires_at?: number;
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
    if (!body.referrer_wallet || !body.set_at || !body.grace_expires_at) {
      return {
        ok: false,
        code: "MALFORMED_RESPONSE",
        message: "set-referrer response missing required fields.",
      };
    }
    return {
      ok: true,
      referrerWallet: body.referrer_wallet,
      setAt: body.set_at,
      graceExpiresAt: body.grace_expires_at,
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
 * - `source` is `"auto_generated"` or `"user_chosen"` — drives the
 *   "can upgrade?" UX.
 * - `status` is `"active"` / `"superseded"` / `"banned"`.
 */
export type MyReferralCodeResult =
  | {
      ok: true;
      code: string;
      walletAddress: Address;
      url?: string;
      source: "auto_generated" | "user_chosen";
      status: "active" | "superseded" | "banned";
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
    body.desired_code = normalized;
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
 * Backend enforces the one-shot rule: a code already at
 * `source='user_chosen'` returns REFERRAL_CODE_LOCKED.
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
    body: { desired_code: normalized },
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

  try {
    const resp = await fetch(`${baseUrl}/v1/me/referral-code`, {
      method: args.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await resp.json()) as {
      code?: string;
      wallet_address?: Address;
      url?: string;
      source?: "auto_generated" | "user_chosen";
      status?: "active" | "superseded" | "banned";
      created_at?: number;
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
    if (
      !body.code ||
      !body.wallet_address ||
      !body.source ||
      !body.status ||
      !body.created_at
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
      walletAddress: body.wallet_address,
      url: body.url,
      source: body.source,
      status: body.status,
      createdAt: body.created_at,
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

/**
 * authenticateWallet signs an EIP-712 WalletLoginIntent with the
 * given viem Account, POSTs /auth/wallet, and returns either the
 * JWT bearer + normalized base URL on success, or a typed failure
 * shape compatible with both ApplyReferralCodeResult and
 * MyReferralCodeResult so callers can `return auth` on the unhappy path.
 */
async function authenticateWallet(
  account: Account,
  backendUrl: string,
): Promise<
  | { ok: true; token: string; baseUrl: string }
  | { ok: false; code: string; message: string; action?: string }
> {
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

  const baseUrl = backendUrl.replace(/\/+$/, "");
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
