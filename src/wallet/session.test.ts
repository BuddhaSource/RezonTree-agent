// SessionManager unit coverage — login-once + expiry-driven refresh.
//
// These tests assert the P0 contract: ensureToken() logs in at most once per
// wallet while the token is fresh, and forces a re-login when the cached
// token is within REFRESH_MARGIN of its `exp`. The login function is
// injected so we can count calls without a live backend.

import { describe, expect, it, vi } from "vitest";

import type { Address, Hex } from "viem";

import {
  REFRESH_MARGIN_SECONDS,
  SessionManager,
  decodeJwtExp,
} from "./session.js";
import type { AgentWallet } from "./types.js";

/** Build an unsigned HS256-shaped JWT with the given `exp` (unix seconds).
 *  SessionManager only reads `exp`, so the signature segment is a stub. */
function makeJwt(exp: number): string {
  const b64url = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ exp })}.sig`;
}

const WALLET: AgentWallet = {
  agentIndex: 0,
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
  privateKey: ("0x" + "11".repeat(32)) as Hex,
  chainId: 84532,
};

describe("decodeJwtExp", () => {
  it("reads the exp claim from a well-formed token", () => {
    expect(decodeJwtExp(makeJwt(1_700_000_000))).toBe(1_700_000_000);
  });
  it("returns null for malformed tokens", () => {
    expect(decodeJwtExp("not-a-jwt")).toBeNull();
    expect(decodeJwtExp("a.b")).toBeNull();
  });
});

describe("SessionManager.ensureToken", () => {
  it("logs in ONCE for two consecutive calls on the same wallet", async () => {
    const now = 1_000_000;
    // Token valid for 15 days — well past the refresh margin.
    const loginFn = vi.fn(async () => makeJwt(now + 15 * 24 * 3600));
    const mgr = new SessionManager({
      apiBase: "http://test",
      loginFn,
      now: () => now,
    });

    const t1 = await mgr.ensureToken(WALLET);
    const t2 = await mgr.ensureToken(WALLET);

    expect(t1).toBe(t2);
    expect(loginFn).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent first-touch logins into ONE call", async () => {
    const now = 1_000_000;
    const loginFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return makeJwt(now + 15 * 24 * 3600);
    });
    const mgr = new SessionManager({ apiBase: "http://test", loginFn, now: () => now });

    const [a, b, c] = await Promise.all([
      mgr.ensureToken(WALLET),
      mgr.ensureToken(WALLET),
      mgr.ensureToken(WALLET),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(loginFn).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the cached token is within REFRESH_MARGIN of exp", async () => {
    let now = 1_000_000;
    // First token expires only just past the margin → second call must refresh.
    const loginFn = vi.fn(async () => makeJwt(now + REFRESH_MARGIN_SECONDS + 10));
    const mgr = new SessionManager({
      apiBase: "http://test",
      loginFn,
      now: () => now,
    });

    const t1 = await mgr.ensureToken(WALLET);
    expect(loginFn).toHaveBeenCalledTimes(1);

    // Advance the clock so the cached token is now inside the refresh margin.
    now += 20;
    const t2 = await mgr.ensureToken(WALLET);

    expect(loginFn).toHaveBeenCalledTimes(2);
    expect(t2).not.toBe(t1);
  });

  it("uses a unique expiresAt per login (collision workaround, no nonce field)", async () => {
    const now = 1_000_000;
    const seenExpiresAt: number[] = [];
    // Each login returns an already-expired token so every ensureToken()
    // re-logs in, letting us observe the expiresAt jitter across logins.
    const loginFn = vi.fn(async (_w: AgentWallet, expiresAt: number) => {
      seenExpiresAt.push(expiresAt);
      return makeJwt(now - 1);
    });
    const mgr = new SessionManager({ apiBase: "http://test", loginFn, now: () => now });

    await mgr.ensureToken(WALLET);
    await mgr.ensureToken(WALLET);
    await mgr.ensureToken(WALLET);

    expect(seenExpiresAt).toHaveLength(3);
    expect(new Set(seenExpiresAt).size).toBe(3); // all distinct → no hash collision
  });

  it("treats a token with no decodable exp as not fresh", async () => {
    const now = 1_000_000;
    const loginFn = vi.fn(async () => "opaque.token"); // no exp claim
    const mgr = new SessionManager({ apiBase: "http://test", loginFn, now: () => now });

    await mgr.ensureToken(WALLET);
    await mgr.ensureToken(WALLET);

    expect(loginFn).toHaveBeenCalledTimes(2);
  });
});
