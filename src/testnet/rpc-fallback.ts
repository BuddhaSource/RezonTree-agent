// rpc-fallback.ts — RPC + HTTP retry/failover for the Phase D battle
// harness.
//
// During the 50-question battle (loop 0136+) sepolia.base.org returned
// 502 from a Cloudflare upstream mid-broadcast and the entire scenario
// crashed. Industry pattern (viem v2 ships fallback transports;
// ethers's FallbackProvider; alchemy SDK's retry-on-5xx) is to wrap
// the RPC client in a multi-endpoint failover and retry transient
// 5xx/network errors with exponential backoff.
//
// This module exposes two primitives:
//   • `makeFallbackTransport(urls)` — viem fallback transport over
//     N HTTP endpoints with retryCount=3.
//   • `fetchWithRetry(url, init)` — fetch wrapper that retries 5xx +
//     network errors but NOT 4xx (validation failures shouldn't loop).
//
// R-REUSE-FIRST — viem already has fallback + retry primitives;
// don't reinvent the request transport. We only own the fetch retry.

import { fallback, http, type FallbackTransport } from "viem";

// Sensible default chain — public Base Sepolia endpoints. Order
// matches typical reliability (sepolia.base.org first because it's
// Coinbase-operated; then publicnode + blockpi as community fallbacks).
export const DEFAULT_BASE_SEPOLIA_RPCS: readonly string[] = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
  "https://base-sepolia.blockpi.network/v1/rpc/public",
] as const;

/** Parses a comma-separated env value into a non-empty URL list. */
export function parseRpcUrls(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the RPC URL list with the documented precedence:
 *   1. RT_AGENT_RPC_URLS (comma-list — preferred)
 *   2. RT_RPC_URL (single URL — legacy)
 *   3. DEFAULT_BASE_SEPOLIA_RPCS
 */
export function resolveRpcUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = parseRpcUrls(env.RT_AGENT_RPC_URLS);
  if (list.length > 0) return list;
  if (env.RT_RPC_URL) return [env.RT_RPC_URL];
  return [...DEFAULT_BASE_SEPOLIA_RPCS];
}

/**
 * Build a viem fallback transport across the supplied endpoints.
 *
 * `retryCount=3` and `retryDelay=300` mean each request retries up
 * to 3 times against the first endpoint with 300/600/1200ms backoff
 * before viem rotates to the next endpoint in the list. With three
 * endpoints we get up to 9 attempts before surfacing the failure —
 * sufficient to ride out a single-RPC outage.
 */
export function makeFallbackTransport(
  urls: readonly string[],
): FallbackTransport {
  if (urls.length === 0) {
    throw new Error(
      "rpc-fallback: empty url list — set RT_AGENT_RPC_URLS or RT_RPC_URL",
    );
  }
  return fallback(
    urls.map((u) => http(u, { retryCount: 3, retryDelay: 300 })),
    { rank: false },
  );
}

// ── HTTP retry (backend localhost calls) ──────────────────────────

/** Sleep N ms — abortable. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

export interface FetchRetryOptions {
  /** Max attempts including the first (default: 4 → 1 initial + 3 retries). */
  maxAttempts?: number;
  /** Backoff sequence in ms. Defaults to [300, 800, 2000]. */
  backoffMs?: readonly number[];
  /** Status codes that are retried. Defaults to 502/503/504. */
  retryStatuses?: readonly number[];
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  /** Inject for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Optional logger. */
  onRetry?: (attempt: number, info: { reason: string; delayMs: number }) => void;
}

/**
 * fetchWithRetry — drop-in for `fetch` that retries transient
 * failures.
 *
 * Retries on:
 *   • Network/abort errors (TypeError thrown by fetch)
 *   • Response status in retryStatuses (default 502, 503, 504)
 *
 * Does NOT retry:
 *   • 4xx (validation; client errors won't get fixed by retrying)
 *   • Final attempt (response is returned as-is)
 *
 * The Response body is not consumed when we retry on a 5xx — caller
 * gets the final Response with its body intact.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? ((ms: number) => sleep(ms));
  const backoff = opts.backoffMs ?? [300, 800, 2000];
  const maxAttempts = opts.maxAttempts ?? backoff.length + 1;
  const retryStatuses = new Set(opts.retryStatuses ?? [502, 503, 504]);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (attempt === maxAttempts || !retryStatuses.has(res.status)) {
        return res;
      }
      // Drain the body so the connection can be reused.
      try {
        await res.text();
      } catch {
        /* ignore */
      }
      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)];
      opts.onRetry?.(attempt, {
        reason: `http ${res.status}`,
        delayMs: delay,
      });
      await sleepImpl(delay);
      continue;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) throw err;
      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)];
      opts.onRetry?.(attempt, {
        reason: `network: ${err instanceof Error ? err.message : String(err)}`,
        delayMs: delay,
      });
      await sleepImpl(delay);
    }
  }
  // Unreachable — loop above always returns or throws on the final
  // attempt — but keep TypeScript happy.
  throw lastError ?? new Error("fetchWithRetry: exhausted attempts");
}
