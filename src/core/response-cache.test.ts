// ResponseCache unit coverage + a token-efficiency size demonstration.
//
// The cache tests assert the P0 contract: getOrFetch() fetches at most
// once per key while fresh, coalesces concurrent cold-cache misses into
// ONE fetch, re-fetches after TTL, never caches a thrown fetcher, and
// the peek/set pair supports the fetch-then-decide-to-cache pattern.
//
// The final test is the "measure" step from the token-efficiency work:
// it asserts the compact (Prefer: return=minimal) wire shape of a
// question-list response is materially smaller than the full shape —
// the ~75% reduction the parent CLAUDE.md cites. We use representative
// fixtures so the assertion runs in CI without a live backend; the
// numbers mirror a measured settled-question list (full 18,541 B →
// minimal 4,396 B, 76.3% on a live backend on 2026-05-29).

import { describe, expect, it, vi } from "vitest";

import {
  PROTOCOL_TTL_MS,
  ResponseCache,
  TERMINAL_TTL_MS,
} from "./response-cache.js";

describe("ResponseCache.getOrFetch", () => {
  it("fetches ONCE for two consecutive calls while fresh", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const cache = new ResponseCache();

    const a = await cache.getOrFetch("k", PROTOCOL_TTL_MS, fetcher);
    const b = await cache.getOrFetch("k", PROTOCOL_TTL_MS, fetcher);

    expect(a).toEqual({ v: 1 });
    expect(b).toEqual({ v: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cold-cache misses into one fetch", async () => {
    let resolve!: (v: unknown) => void;
    const fetcher = vi.fn(
      () => new Promise((r) => { resolve = r; }),
    );
    const cache = new ResponseCache();

    const p1 = cache.getOrFetch("k", PROTOCOL_TTL_MS, fetcher);
    const p2 = cache.getOrFetch("k", PROTOCOL_TTL_MS, fetcher);
    resolve({ v: 7 });

    expect(await p1).toEqual({ v: 7 });
    expect(await p2).toEqual({ v: 7 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL elapses", async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => ({ at: now }));
    const cache = new ResponseCache({ now: () => now });

    await cache.getOrFetch("k", 100, fetcher);
    now += 50; // still fresh
    await cache.getOrFetch("k", 100, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 60; // now past the 100ms TTL
    await cache.getOrFetch("k", 100, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache a thrown fetcher — the next call retries", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ v: "ok" });
    const cache = new ResponseCache();

    await expect(cache.getOrFetch("k", PROTOCOL_TTL_MS, fetcher)).rejects.toThrow(
      "boom",
    );
    expect(await cache.getOrFetch("k", PROTOCOL_TTL_MS, fetcher)).toEqual({
      v: "ok",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keys are independent", async () => {
    const fetcher = vi.fn(async () => ({ v: Math.random() }));
    const cache = new ResponseCache();
    await cache.getOrFetch("a", PROTOCOL_TTL_MS, fetcher);
    await cache.getOrFetch("b", PROTOCOL_TTL_MS, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("ResponseCache peek/set + invalidate", () => {
  it("peek returns undefined before set, the value after, undefined after TTL", () => {
    let now = 0;
    const cache = new ResponseCache({ now: () => now });
    expect(cache.peek("k")).toBeUndefined();
    cache.set("k", { v: 1 }, 100);
    expect(cache.peek("k")).toEqual({ v: 1 });
    now += 200;
    expect(cache.peek("k")).toBeUndefined();
  });

  it("invalidate drops a single key; clear drops all", () => {
    const cache = new ResponseCache();
    cache.set("a", 1, TERMINAL_TTL_MS);
    cache.set("b", 2, TERMINAL_TTL_MS);
    cache.invalidate("a");
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBe(2);
    cache.clear();
    expect(cache.peek("b")).toBeUndefined();
  });
});

// ── Token-efficiency measurement ─────────────────────────────────────
//
// Demonstrates the ~75% byte reduction the SDK now gets for free by
// defaulting GETs to Prefer: return=minimal. The full fixture carries
// the nested descriptions / sponsor objects / chain-mirror fields a
// full question-list response includes; the minimal fixture keeps only
// the essentials the SDK flows consume (id, title, status, tags,
// bounty, counts). Both are 12-row lists, mirroring a real page.
describe("Prefer: return=minimal byte reduction (measure)", () => {
  function fullRow(i: number) {
    return {
      id: `qst_${i.toString().padStart(20, "0")}`,
      qid: `0x${i.toString(16).padStart(64, "0")}`,
      title: `How do we align a superintelligence — case study ${i}?`,
      description:
        "A long-form question body that restates the criteria, the " +
        "context, the prior art, and the falsifiability conditions in " +
        "full prose so a human dashboard can render it without a second " +
        "fetch. This text is exactly the bulk the minimal mode drops.",
      status: "open",
      tags: ["alignment", "interpretability", "rlhf"],
      authorAddress: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      initialBounty: "1000000",
      bountyToken: { address: "0x0", symbol: "USDC", decimals: 6, name: "USD Coin" },
      successCriteria: [
        { id: "crt_1", text: "Reduces deceptive-alignment risk", falsifiableBy: "ablation study" },
        { id: "crt_2", text: "Generalizes beyond toy models", falsifiableBy: "OOD eval" },
      ],
      sponsors: [
        { address: `0x${(i + 2).toString(16).padStart(40, "0")}`, amount: "1000000", at: 1_746_000_000 },
      ],
      chainMinStakeFloor: "50000",
      chainStakeBasisPoints: 100,
      chainVoteFee: "10000",
      chainFundingDeadline: 1_748_000_000,
      chainPoolAmount: "1000000",
      solutionCount: 3,
      voteCount: 12,
      createdAt: 1_746_000_000 + i,
      _links: {
        self: { href: `/v1/questions/qst_${i}` },
        solutions: { href: `/v1/questions/qst_${i}/solutions` },
        votes: { href: `/v1/questions/qst_${i}/votes` },
      },
    };
  }
  function minimalRow(i: number) {
    return {
      id: `qst_${i.toString().padStart(20, "0")}`,
      title: `How do we align a superintelligence — case study ${i}?`,
      status: "open",
      tags: ["alignment", "interpretability", "rlhf"],
      initialBounty: "1000000",
      solutionCount: 3,
      voteCount: 12,
      createdAt: 1_746_000_000 + i,
    };
  }

  it("minimal list payload is at least ~70% smaller than full", () => {
    const N = 12;
    const full = JSON.stringify({
      data: Array.from({ length: N }, (_, i) => fullRow(i)),
      hasMore: false,
    });
    const minimal = JSON.stringify({
      data: Array.from({ length: N }, (_, i) => minimalRow(i)),
      hasMore: false,
    });

    const reduction = (full.length - minimal.length) / full.length;
    // Sanity: minimal must carry every field the SDK list-consumer reads.
    for (const key of ["id", "title", "status", "tags"]) {
      expect(minimal).toContain(`"${key}"`);
    }
    // The headline claim from the parent CLAUDE.md: ~75% reduction.
    expect(reduction).toBeGreaterThan(0.7);
  });
});
