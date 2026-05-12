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

  // 1. Sign the login intent.
  let signedLogin: SignedLoginBody;
  try {
    signedLogin = await signLogin(args.account);
  } catch (err) {
    return {
      ok: false,
      code: "SIGN_FAILED",
      message: `Failed to sign WalletLoginIntent: ${errMsg(err)}`,
    };
  }

  // 2. Exchange for a JWT.
  const baseUrl = args.backendUrl.replace(/\/+$/, "");
  let token: string;
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
    token = body.accessToken;
  } catch (err) {
    return {
      ok: false,
      code: "AUTH_NETWORK_ERROR",
      message: `Network error against ${baseUrl}/auth/wallet: ${errMsg(err)}`,
    };
  }

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

// ── Internals ────────────────────────────────────────────────────────

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
