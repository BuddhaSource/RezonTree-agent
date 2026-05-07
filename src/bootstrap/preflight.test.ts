// Preflight coverage.
//
// Unit tests exercise the pure-function surface
// (formatPreflightReport) + the end-to-end runPreflight
// function via stubbed globalThis.fetch. The CLI entry path
// (reading process.argv, process.exit) isn't unit-tested —
// it's a 20-line glue surface that's easier to eyeball-verify.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HARDHAT_TEST_MNEMONIC } from "../wallet/derive.js";
import { formatPreflightReport, runPreflight } from "./preflight.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  // Scrub env between tests so one test's state doesn't leak.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("RT_AGENT_") || k === "REZONTREE_API_URL") {
      delete process.env[k];
    }
  }
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

describe("formatPreflightReport", () => {
  it("prints one line per check with a ✓ or ✗", () => {
    const out = formatPreflightReport([
      { name: "check a", passed: true, detail: "ok" },
      { name: "check b", passed: false, detail: "fail reason" },
    ]);
    expect(out).toContain("✓ check a");
    expect(out).toContain("✗ check b");
    expect(out).toContain("fail reason");
  });

  it("includes the name column padded for alignment", () => {
    const out = formatPreflightReport([
      { name: "short", passed: true, detail: "d" },
    ]);
    // Format: `    ${mark} ${name.padEnd(24)} ${detail}`
    // "short" is 5 chars → padEnd(24) = "short" + 19 spaces,
    // then a literal separator space + detail "d" = 20 spaces
    // between the two words.
    expect(out).toMatch(/short {20}d/);
  });
});

describe("runPreflight — exit codes", () => {
  it("returns 2 when RT_AGENT_MNEMONIC is missing", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    const { code, results } = await runPreflight();
    expect(code).toBe(2);
    const mnemCheck = results.find((r) => r.name === "RT_AGENT_MNEMONIC set");
    expect(mnemCheck?.passed).toBe(false);
  });

  it("returns 1 when backend is unreachable", async () => {
    setEnv({
      RT_AGENT_MNEMONIC: HARDHAT_TEST_MNEMONIC,
      RT_AGENT_BACKEND_URL: "http://127.0.0.1:1",
    });
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { code, results } = await runPreflight();
    expect(code).toBe(1);
    const r = results.find((x) => x.name === "backend /healthz");
    expect(r?.passed).toBe(false);
  });

  it("returns 0 when all checks pass", async () => {
    setEnv({
      RT_AGENT_MNEMONIC: HARDHAT_TEST_MNEMONIC,
      RT_AGENT_BACKEND_URL: "http://mock",
    });
    globalThis.fetch = (async (url) => {
      const s = String(url);
      if (s.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (s.endsWith("/auth/wallet")) {
        return new Response(
          JSON.stringify({ accessToken: "jwt.mock", address: "agt_mock" }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const { code, results } = await runPreflight();
    expect(code).toBe(0);
    expect(results.every((r) => r.passed)).toBe(true);
    const wl = results.find((r) => r.name === "wallet /auth/wallet");
    expect(wl?.detail).toContain("agt_mock");
  });

  it("returns 1 when backend rejects the signed intent", async () => {
    setEnv({
      RT_AGENT_MNEMONIC: HARDHAT_TEST_MNEMONIC,
      RT_AGENT_BACKEND_URL: "http://mock",
    });
    globalThis.fetch = (async (url) => {
      const s = String(url);
      if (s.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (s.endsWith("/auth/wallet")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "SIGNATURE_MISMATCH",
              message: "recovered address differs from claimed",
              action: "Rebuild the intent with the correct chain_id.",
            },
          }),
          { status: 401 },
        );
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const { code, results } = await runPreflight();
    expect(code).toBe(1);
    const wl = results.find((r) => r.name === "wallet /auth/wallet");
    expect(wl?.passed).toBe(false);
    // The backend's teaching action makes it into the detail
    // line — useful for the operator.
    expect(wl?.detail).toContain("SIGNATURE_MISMATCH");
    expect(wl?.detail).toContain("Rebuild the intent");
  });

  it("derives 6 distinct addresses from the mnemonic", async () => {
    setEnv({
      RT_AGENT_MNEMONIC: HARDHAT_TEST_MNEMONIC,
      RT_AGENT_BACKEND_URL: "http://mock",
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    const { results } = await runPreflight();
    const r = results.find((x) => x.name === "6 agent addresses");
    expect(r?.passed).toBe(true);
    expect(r?.detail).toContain("6 distinct");
  });
});
