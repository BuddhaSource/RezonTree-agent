// ResponseCache — session-scoped cache for stable GET reads.
//
// PROBLEM. Agents driving the protocol re-fetch the same stable
// documents over and over inside one session: the protocol-discovery
// doc (`/v1/protocol`), the token registry, the immutable detail of a
// settled/abandoned question. Each re-fetch costs a round-trip AND
// burns context-window tokens re-reading bytes that did not change.
// The parent CLAUDE.md API-consumption rules call this out directly:
// "Cache /v1/protocol", "Cache `rev` from schema errors".
//
// FIX. A tiny TTL cache keyed by a caller-supplied string. It mirrors
// the freshness + in-flight-coalescing shape of SessionManager
// (src/wallet/session.ts): a single getOrFetch() returns a cached
// value while fresh, coalesces concurrent cold-cache misses into ONE
// fetch, and re-fetches only after the entry's TTL elapses. Unlike
// SessionManager it is value-agnostic — the caller decides what to
// cache and for how long.
//
// SCOPE. This is for SESSION-STABLE reads only. Never cache
// confirmation-polling reads, pending-intent reads, or any list whose
// freshness the agent's next action depends on — those must hit the
// wire every time. Use the per-call TTLs below as the contract:
//   - PROTOCOL_TTL_MS    /v1/protocol, token registry (stable within a
//                        deploy; a long TTL is safe — drift surfaces as
//                        a SCHEMA_CHANGED error on the next write).
//   - TERMINAL_TTL_MS    settled/abandoned question detail (immutable
//                        once the chain reaches a terminal status).

/** Default TTL for discovery/registry docs — stable within a deploy. */
export const PROTOCOL_TTL_MS = 30 * 60_000; // 30 min

/** Default TTL for terminal-state resources (settled/abandoned). */
export const TERMINAL_TTL_MS = 30 * 60_000; // 30 min

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * ResponseCache caches stable GET responses keyed by a string. One
 * instance per process (or per MCP server) collapses repeated reads of
 * the protocol doc / token registry / terminal-question detail to a
 * single fetch per TTL window. Value-agnostic and dependency-free.
 */
export class ResponseCache {
  private readonly mem = new Map<string, Entry>();
  /** In-flight fetches keyed by cache key, so concurrent misses for the
   *  same key share ONE fetch instead of racing N. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Return the cached value for `key` while fresh; otherwise call
   * `fetcher`, cache its result for `ttlMs`, and return it. Concurrent
   * cold-cache calls for the same key coalesce onto one in-flight fetch.
   *
   * A thrown fetcher is NOT cached — the next call retries.
   */
  async getOrFetch<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const nowMs = this.now();
    const cached = this.mem.get(key);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value as T;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const p = (async () => {
      const value = await fetcher();
      this.mem.set(key, { value, expiresAt: this.now() + ttlMs });
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p as Promise<T>;
  }

  /** Return the cached value for `key` while fresh, else `undefined`.
   *  Pure read — never fetches. Use when the caller decides at runtime
   *  whether a value is cacheable (e.g. only cache terminal rows). */
  peek<T>(key: string): T | undefined {
    const cached = this.mem.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value as T;
    }
    return undefined;
  }

  /** Store a value for `key` for `ttlMs`. Companion to peek() for the
   *  fetch-then-decide-to-cache pattern. */
  set(key: string, value: unknown, ttlMs: number): void {
    this.mem.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Drop a single key (e.g. after a SCHEMA_CHANGED error invalidates a
   *  cached protocol doc). */
  invalidate(key: string): void {
    this.mem.delete(key);
  }

  /** Drop everything (e.g. on a wallet/identity switch within a process). */
  clear(): void {
    this.mem.clear();
  }
}
