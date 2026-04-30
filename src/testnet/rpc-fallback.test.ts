// rpc-fallback.test.ts — unit coverage for the harness retry/failover.
//
// Tests target the fetch-retry surface (the viem fallback transport
// is library code; we only test our wrapper). Mocks fetch so no
// network is required.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_SEPOLIA_RPCS,
  fetchWithRetry,
  makeFallbackTransport,
  parseRpcUrls,
  resolveRpcUrls,
} from "./rpc-fallback.js";

function mockResponse(status: number, body = ""): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseRpcUrls", () => {
  it("returns empty for undefined", () => {
    expect(parseRpcUrls(undefined)).toEqual([]);
  });
  it("splits comma-list and trims", () => {
    expect(parseRpcUrls("https://a.example, https://b.example , ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("resolveRpcUrls", () => {
  it("prefers RT_AGENT_RPC_URLS", () => {
    expect(
      resolveRpcUrls({
        RT_AGENT_RPC_URLS: "https://primary,https://backup",
        RT_RPC_URL: "https://legacy",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://primary", "https://backup"]);
  });
  it("falls back to RT_RPC_URL", () => {
    expect(
      resolveRpcUrls({
        RT_RPC_URL: "https://legacy",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://legacy"]);
  });
  it("falls back to defaults when nothing set", () => {
    expect(resolveRpcUrls({} as NodeJS.ProcessEnv)).toEqual([
      ...DEFAULT_BASE_SEPOLIA_RPCS,
    ]);
  });
});

describe("makeFallbackTransport", () => {
  it("rejects empty url list", () => {
    expect(() => makeFallbackTransport([])).toThrow(/empty url list/);
  });
  it("returns a transport function for non-empty list", () => {
    const t = makeFallbackTransport(["https://a.example"]);
    expect(typeof t).toBe("function");
  });
});

describe("fetchWithRetry", () => {
  it("returns 200 on first try without sleeping", async () => {
    let calls = 0;
    let slept = false;
    const r = await fetchWithRetry(
      "http://t/echo",
      undefined,
      {
        fetchImpl: async () => {
          calls++;
          return mockResponse(200, "ok");
        },
        sleepImpl: async () => {
          slept = true;
        },
      },
    );
    expect(r.status).toBe(200);
    expect(calls).toBe(1);
    expect(slept).toBe(false);
  });

  it("retries 502 twice then succeeds (3 total fetches, 2 sleeps)", async () => {
    let calls = 0;
    const sleepDelays: number[] = [];
    const r = await fetchWithRetry(
      "http://t/flaky",
      undefined,
      {
        fetchImpl: async () => {
          calls++;
          if (calls <= 2) return mockResponse(502, "upstream");
          return mockResponse(200, '{"ok":true}');
        },
        sleepImpl: async (ms) => {
          sleepDelays.push(ms);
        },
      },
    );
    expect(r.status).toBe(200);
    expect(calls).toBe(3);
    expect(sleepDelays).toEqual([300, 800]);
  });

  it("does NOT retry 4xx — returns immediately", async () => {
    let calls = 0;
    const r = await fetchWithRetry(
      "http://t/bad",
      undefined,
      {
        fetchImpl: async () => {
          calls++;
          return mockResponse(400, "bad request");
        },
        sleepImpl: async () => {
          throw new Error("should not sleep");
        },
      },
    );
    expect(r.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("retries network errors", async () => {
    let calls = 0;
    const r = await fetchWithRetry(
      "http://t/net",
      undefined,
      {
        fetchImpl: async () => {
          calls++;
          if (calls === 1) throw new TypeError("fetch failed");
          return mockResponse(200, "ok");
        },
        sleepImpl: async () => {},
      },
    );
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("returns final 502 after exhausting attempts", async () => {
    let calls = 0;
    const r = await fetchWithRetry(
      "http://t/dead",
      undefined,
      {
        fetchImpl: async () => {
          calls++;
          return mockResponse(502, "still dead");
        },
        sleepImpl: async () => {},
        backoffMs: [10, 10, 10],
      },
    );
    expect(r.status).toBe(502);
    expect(calls).toBe(4); // 1 + 3 retries
  });

  it("invokes onRetry hook with reason + delay", async () => {
    let calls = 0;
    const seen: Array<{ attempt: number; reason: string; delayMs: number }> =
      [];
    await fetchWithRetry(
      "http://t/hook",
      undefined,
      {
        fetchImpl: async () => {
          calls++;
          if (calls === 1) return mockResponse(503);
          return mockResponse(200);
        },
        sleepImpl: async () => {},
        onRetry: (attempt, info) =>
          seen.push({ attempt, reason: info.reason, delayMs: info.delayMs }),
      },
    );
    expect(seen).toEqual([{ attempt: 1, reason: "http 503", delayMs: 300 }]);
  });
});
