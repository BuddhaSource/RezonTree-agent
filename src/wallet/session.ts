// SessionManager — per-wallet JWT session cache (login once, reuse).
//
// PROBLEM. The swarm/sweep harnesses used to call the wallet-login flow
// (sign a WalletLoginIntent → POST /v1/sessions) per (agent, action) or
// per (agent, question) pair. With 10 agents × 11 questions that is ~110
// logins per run, which (a) hammers the auth rate limit and (b) collides on
// the backend's login-intent dedup key.
//
// The backend's dedup key is (chain_id, intent_hash) where intent_hash =
// keccak256 over the WalletLoginIntent struct (ethAddress, chainId,
// expiresAt) — see internal/auth/auth_service.go LoginByWallet and
// internal/signer/wallet_login_intent.go. The struct has NO nonce field, so
// two logins from the same wallet in the same second with the same
// `expiresAt` produce an IDENTICAL hash → the second is rejected as a replay
// (LOGIN_INTENT_REPLAYED). This bites parallel cold-start logins.
//
// FIX (two layers):
//   1. Cache the JWT keyed by wallet address. The backend access-token TTL
//      is now 15 days (360h, ACCESS_TOKEN_TTL), so one login covers an
//      entire harness run. ensureToken() returns the cached token unless it
//      is missing or within REFRESH_MARGIN of its `exp`.
//   2. Per-login uniqueness via sub-second jitter on `expiresAt`. The login
//      intent has no nonce, so we make the (signer, expiresAt) pair unique
//      per login by adding a small monotonic+random second offset. This is
//      a CLIENT-SIDE WORKAROUND; the proper fix is a `nonce` field on the
//      backend WalletLoginIntent struct (flagged for the parent session).
//
// CONSOLIDATION. The signing lives in signer.ts (signWalletLoginIntent) and
// the EIP-712 domain in domain.ts; this module owns the HTTP login + cache,
// replacing the duplicated login bodies in scripts/lib/operator-recovery.ts
// (loginWallet) and scripts/fee-swarm.ts (login).

import { promises as fs } from "node:fs";
import path from "node:path";

import type { Address } from "viem";

import { type LoginDomain, loadLoginDomain } from "./domain.js";
import { signWalletLoginIntent } from "./signer.js";
import type { AgentWallet } from "./types.js";

/** Refresh the cached token when it is within this many seconds of `exp`. */
export const REFRESH_MARGIN_SECONDS = 5 * 60;

/** Login-intent TTL we request. Backend ceiling is 15 min (WalletLoginMaxTTL);
 *  600s leaves margin for clock skew + network RTT. The token issued in
 *  return lives for ACCESS_TOKEN_TTL (15 days), independent of this. */
const LOGIN_INTENT_TTL_SECONDS = 600;

/** decodeJwtExp reads the `exp` (unix seconds) claim from an HS256 JWT
 *  WITHOUT verifying the signature — we only need expiry to decide cache
 *  freshness; the backend remains authoritative on validity. Returns null if
 *  the token is malformed or carries no numeric `exp`. */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64, then decode the payload (middle) segment.
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(payloadB64, "base64").toString("utf8");
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

/** A token is fresh if it has a future `exp` further than REFRESH_MARGIN
 *  away. A token with no decodable `exp` is treated as NOT fresh (force a
 *  re-login rather than trust an opaque token). */
function isFresh(token: string, nowSeconds: number): boolean {
  const exp = decodeJwtExp(token);
  if (exp === null) return false;
  return exp - nowSeconds > REFRESH_MARGIN_SECONDS;
}

interface CachedSession {
  token: string;
  address: Address;
}

/** loginFn performs the actual sign+POST and returns the access token.
 *  Injectable so tests can assert call count without a live backend. */
export type LoginFn = (wallet: AgentWallet, expiresAt: number) => Promise<string>;

export interface SessionManagerOptions {
  /** API base, e.g. http://localhost:8080 (no trailing slash). */
  apiBase: string;
  /** EIP-712 login domain. Defaults to loadLoginDomain(). */
  domain?: LoginDomain;
  /** Override the network login (tests). Defaults to the real /v1/sessions POST. */
  loginFn?: LoginFn;
  /** Directory for the optional cross-process disk cache. When set, tokens
   *  are persisted per-address so a second harness process reuses an existing
   *  session instead of logging in again. Gitignored (.sessions/). */
  diskCacheDir?: string;
  /** Clock source (seconds). Injectable for tests. */
  now?: () => number;
}

/**
 * SessionManager caches one JWT per wallet address. All API calls should
 * route through ensureToken(wallet) instead of logging in directly. A single
 * instance per process collapses the swarm's per-action login fan-out to one
 * login per wallet; the optional disk cache extends that across processes.
 */
export class SessionManager {
  private readonly apiBase: string;
  private readonly domain: LoginDomain;
  private readonly loginFn: LoginFn;
  private readonly diskCacheDir?: string;
  private readonly now: () => number;

  private readonly mem = new Map<string, CachedSession>();
  /** In-flight logins keyed by address, so concurrent ensureToken() calls
   *  for the same wallet share ONE login rather than racing N. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: SessionManagerOptions) {
    this.apiBase = opts.apiBase.replace(/\/$/, "");
    this.domain = opts.domain ?? loadLoginDomain();
    this.diskCacheDir = opts.diskCacheDir;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.loginFn = opts.loginFn ?? this.defaultLogin.bind(this);
  }

  /** Monotonic per-instance counter feeding the expiresAt jitter so two
   *  same-second logins never produce the same intent hash. */
  private jitterSeq = 0;

  /** Return a valid JWT for `wallet`, logging in at most once. Subsequent
   *  calls return the cached token until it is within REFRESH_MARGIN of exp. */
  async ensureToken(wallet: AgentWallet): Promise<string> {
    const key = wallet.address.toLowerCase();
    const nowS = this.now();

    const cached = this.mem.get(key);
    if (cached && isFresh(cached.token, nowS)) return cached.token;

    // Coalesce concurrent first-touch logins for the same wallet.
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = this.refresh(wallet).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refresh(wallet: AgentWallet): Promise<string> {
    const key = wallet.address.toLowerCase();

    // Try the disk cache before paying for a network login (cross-process).
    const fromDisk = await this.readDisk(key);
    if (fromDisk && isFresh(fromDisk, this.now())) {
      this.mem.set(key, { token: fromDisk, address: wallet.address as Address });
      return fromDisk;
    }

    // expiresAt jitter: base + monotonic offset keeps (signer, expiresAt)
    // unique per login even under same-second parallel cold start. Capped
    // well under the backend's 15-min TTL ceiling.
    const jitter = (this.jitterSeq++ % 120) + Math.floor(Math.random() * 60);
    const expiresAt = this.now() + LOGIN_INTENT_TTL_SECONDS + jitter;

    const token = await this.loginFn(wallet, expiresAt);
    this.mem.set(key, { token, address: wallet.address as Address });
    await this.writeDisk(key, token);
    return token;
  }

  /** Default login: sign a WalletLoginIntent and POST it to /v1/sessions. */
  private async defaultLogin(wallet: AgentWallet, expiresAt: number): Promise<string> {
    const body = await signWalletLoginIntent({ wallet, expiresAt, domain: this.domain });
    const res = await fetch(`${this.apiBase}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(
        `login (${wallet.address}) failed: ${res.status} ${await res.text()}`,
      );
    }
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) {
      throw new Error(`login (${wallet.address}) returned no accessToken`);
    }
    return data.accessToken;
  }

  private diskPath(key: string): string | null {
    if (!this.diskCacheDir) return null;
    // key is a lowercase 0x EVM address — safe filename, no traversal.
    return path.join(this.diskCacheDir, `${key}.jwt`);
  }

  private async readDisk(key: string): Promise<string | null> {
    const p = this.diskPath(key);
    if (!p) return null;
    try {
      const token = (await fs.readFile(p, "utf8")).trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  private async writeDisk(key: string, token: string): Promise<void> {
    const p = this.diskPath(key);
    if (!p) return;
    try {
      await fs.mkdir(this.diskCacheDir!, { recursive: true });
      await fs.writeFile(p, token, { mode: 0o600 });
    } catch {
      // Disk cache is best-effort; in-memory cache still holds the token.
    }
  }
}
