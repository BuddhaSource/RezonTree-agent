// server.test.ts — drift fence for the local MCP boundary.
//
// Architectural invariant: this MCP keeps only what cannot live on
// the hosted MCP — wallet identity, signing, broadcast, and stable
// craft prompts. Every backend read endpoint that isn't part of a
// sign-and-broadcast composite belongs on hosted MCP; mirroring it
// here re-creates the drift surface the hosted-MCP-first split was
// built to eliminate.
//
// These tests parse server.ts as source text — no runtime, no mocks.
// The point is to catch a re-introduction the moment someone adds an
// errant `apiCall("GET", "/v1/accounts/...")` and re-runs the test
// suite, well before that change ships to an agent.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  StructuredMCPError,
  parseBackendErrorEnvelope,
} from "./errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = readFileSync(join(__dirname, "server.ts"), "utf8");

// EXPECTED_TOOLS is the curated set of locally-registered MCP tools.
// Updating this list is a deliberate gate: a new tool here must
// justify why it needs local support (wallet, sign, broadcast,
// methodology) and cannot live on hosted MCP.
const EXPECTED_TOOLS = new Set<string>([
  // Sign + broadcast composites — preflight → sign → POST signed → broadcast.
  "submit_solution",
  "cast_vote",
  "fund_question",
  "claim_payout",
  "post_question",
  // Wallet identity / on-chain reads bound to the local private key.
  "me",
  "cold_start",
  "get_usdc_balance",
  "wallet_topup_faucet",
  // Auth bridge — issues JWT from a local signature.
  "get_session_token",
  // Methodology / craft — stable agent guidance with no backend dep.
  "craft_question",
  "craft_solution",
  "craft_vote",
  "craft_weight_split",
  "craft_cost_check",
  "craft_error_recovery",
  "craft_dedup_strategy",
  "craft_research_registry",
  // Activity discovery — long-poll for new actionable questions. Local
  // because it pairs with the local JWT issuer + the agent's
  // wallet-scoped /v1/me view of which questions are open to them.
  "wait_for_questions",
  // Methodology / craft — advisory text fetched once per session, no
  // backend dep. Pairs with the post_question composite.
  "get_craft_advice",
]);

// ALLOWED_API_PATHS lists the path patterns an `apiCall(...)` site may
// hit. Each entry is a regex; the path literal extracted from source
// must match at least one. Every allowed pattern is part of a sign-
// and-broadcast orchestration (preflight, signed envelope POST, or
// claim-proof fetch that feeds Router.claim).
//
// Anything else — GET /v1/accounts/..., GET /v1/me/..., GET on a list
// endpoint — is an API mirror and must move to hosted MCP.
const ALLOWED_API_PATHS: Array<RegExp> = [
  // Preflights — backend authors canonical params + expectedIntentHash.
  /^\/v1\/questions\/[^/]+\/solutions\/draft(\?|$)/,
  /^\/v1\/questions\/[^/]+\/votes\/draft(\?|$)/,
  /^\/v1\/questions\/[^/]+\/sponsorships\/draft(\?|$)/,
  // Atomic create+sponsor — only inside post_question composite.
  /^\/v1\/questions$/,
  // Question detail — used by fund_question's sponsor-mode orphan-draft
  // recovery to reload title + body so the SponsorWitness content hash
  // matches what post_question would have emitted.
  /^\/v1\/questions\/[^/]+$/,
  // Unified Quadphase v2 submit — universal signed-envelope POST that
  // replaced /v1/questions/:id/{commit,vote-intent,sponsorships}. Same
  // contract (sign-then-POST-then-broadcast); the SDK posts envelope+
  // witness+signature here, then broadcasts submit()/sponsorSubmit().
  /^\/v1\/quadphase\/submit$/,
  // Claim proof — fetched and immediately handed to Router.claim broadcast.
  /^\/v1\/questions\/[^/]+\/claims\/[^/]+$/,
];

describe("local MCP boundary — drift fences", () => {
  it("registers exactly the curated tool set", () => {
    // Extract every server.tool("name", ...) registration. Methodology
    // tools are registered via a loop with `tool.name` — they aren't
    // string literals here, so we also pull their names from the
    // methodology source.
    const literalMatches = [
      ...SERVER_TS.matchAll(/server\.tool\(\s*"([a-z_][a-z0-9_]*)"/g),
    ].map((m) => m[1]);

    const methodologySrc = readFileSync(
      join(__dirname, "..", "..", "src", "methodology", "index.ts"),
      "utf8",
    );
    const methodologyMatches = [
      ...methodologySrc.matchAll(/name:\s*"(craft_[a-z_]+)"/g),
    ].map((m) => m[1]);

    const registered = new Set<string>([
      ...literalMatches,
      ...methodologyMatches,
    ]);

    // Symmetric-difference report — names in source but not allowed
    // (re-introduction of a hosted-MCP-territory tool) AND names in
    // the allowlist but not in source (a tool was deleted without
    // updating the allowlist).
    const extra = [...registered].filter((n) => !EXPECTED_TOOLS.has(n));
    const missing = [...EXPECTED_TOOLS].filter((n) => !registered.has(n));

    expect(
      { extra, missing },
      "Local MCP tool surface drifted. If you added a tool that needs " +
        "local support (wallet/sign/broadcast/methodology), add it to " +
        "EXPECTED_TOOLS. If it was a backend read mirror, move it to the " +
        "hosted MCP at backend `/mcp` instead.",
    ).toEqual({ extra: [], missing: [] });
  });

  it("every apiCall path is a sign-and-broadcast orchestration step", () => {
    // Capture each apiCall(...) and the path-template literal that
    // follows the HTTP method. The path is a template-string with
    // ${...} interpolations — keep them literal and strip the dollar-
    // brace pairs to match against ALLOWED_API_PATHS.
    const sites = [
      ...SERVER_TS.matchAll(
        /apiCall\(\s*"(GET|POST|PATCH|PUT|DELETE)"\s*,\s*[`"]([^`"]+)[`"]/g,
      ),
    ];

    // Sanity: if the inventory drops to zero, the regex broke — fail
    // loud rather than silently passing.
    expect(sites.length, "apiCall inventory empty — regex broken?").toBeGreaterThan(
      5,
    );

    const offenders: Array<{ method: string; path: string }> = [];
    for (const m of sites) {
      const method = m[1];
      // Strip ${...} interpolations to a wildcard segment for matching.
      const literalPath = m[2].replace(/\$\{[^}]+\}/g, "X");
      if (!ALLOWED_API_PATHS.some((re) => re.test(literalPath))) {
        offenders.push({ method, path: m[2] });
      }
    }

    expect(
      offenders,
      "Local MCP made a backend call that is NOT part of a sign-and-" +
        "broadcast orchestration. If this is a new read, expose it via " +
        "the hosted MCP at backend `/mcp` and have the agent call it " +
        "there. If it's a new sign-flow step, add its path pattern to " +
        "ALLOWED_API_PATHS with a comment explaining why it's local.",
    ).toEqual([]);
  });

  // Regression for the trim that landed alongside this fence: `me`
  // and `cold_start` MUST NOT mirror backend account reads.
  // The hosted MCP exposes `rezontree_accounts_list_profile` and
  // `rezontree_accounts_list_participating-questions` for that.
  describe("me + cold_start stay local-only", () => {
    function sliceTool(name: string): string {
      const start = SERVER_TS.indexOf(`server.tool(\n  "${name}"`);
      expect(start, `tool "${name}" not found`).toBeGreaterThan(-1);
      // Find the matching ");" that closes the tool registration.
      // Tools are top-level so the first ");" at column-0 ends them.
      const after = SERVER_TS.slice(start);
      const endRel = after.search(/^\);/m);
      expect(endRel, `tool "${name}" not terminated`).toBeGreaterThan(-1);
      return after.slice(0, endRel);
    }

    // Inspect only `apiCall(...)` path arguments, not description /
    // hint text — those legitimately name the hosted-MCP equivalents
    // (`rezontree_accounts_list_profile` etc.) as instructions to the
    // agent. The drift we're guarding against is local code making
    // the call, not local code mentioning it.
    function apiCallPaths(toolBody: string): string[] {
      return [
        ...toolBody.matchAll(
          /apiCall\(\s*"(?:GET|POST|PATCH|PUT|DELETE)"\s*,\s*[`"]([^`"]+)[`"]/g,
        ),
      ].map((m) => m[1]);
    }

    it("`me` does not fetch profile or participating-questions", () => {
      const paths = apiCallPaths(sliceTool("me"));
      expect(paths.some((p) => p.includes("/profile"))).toBe(false);
      expect(paths.some((p) => p.includes("/participating-questions"))).toBe(
        false,
      );
    });

    it("`cold_start` does not fetch profile or participating-questions", () => {
      const paths = apiCallPaths(sliceTool("cold_start"));
      expect(paths.some((p) => p.includes("/profile"))).toBe(false);
      expect(paths.some((p) => p.includes("/participating-questions"))).toBe(
        false,
      );
    });
  });
});

// ─── Backend error envelope → StructuredMCPError ───────────
//
// A solver agent burned $1.90 / 114 turns chasing a phantom binary-
// staleness diagnosis because the local MCP wrapped a backend error
// as "Request body is not valid JSON" instead of surfacing the
// envelope verbatim. These tests fence the round-trip so the LLM
// caller always sees the backend's prescriptive {code, message,
// action, requestId} contract — plus details.diff / details.schema
// for SCHEMA_CHANGED and details.fieldErrors for validation.

describe("backend error envelope → MCP tool result", () => {
  it("preserves all four prescriptive fields verbatim", () => {
    const args = parseBackendErrorEnvelope({
      data: {
        error: {
          code: "DUPLICATE_ACTIVE",
          message:
            "Solution for question qst_abc with this body already active.",
          action:
            "Fetch /v1/questions/qst_abc/solutions to find your existing entry. Retry only with a different body hash.",
          requestId: "req_8f3a1c",
        },
      },
      rawText: "",
      status: 409,
      fallbackAction: "fallback",
    });
    expect(args.code).toBe("DUPLICATE_ACTIVE");
    expect(args.message).toContain("already active");
    expect(args.action).toContain("different body hash");
    expect(args.requestId).toBe("req_8f3a1c");
    expect(args.httpStatus).toBe(409);

    const err = new StructuredMCPError(args);
    const wire = JSON.parse(err.message) as Record<string, unknown>;
    expect(wire.ok).toBe(false);
    expect(wire.errorCode).toBe("DUPLICATE_ACTIVE");
    expect(wire.errorMessage).toContain("already active");
    expect(wire.errorAction).toContain("different body hash");
    expect(wire.requestId).toBe("req_8f3a1c");
    expect(wire.httpStatus).toBe(409);
  });

  it("preserves details.diff for SCHEMA_CHANGED", () => {
    const args = parseBackendErrorEnvelope({
      data: {
        error: {
          code: "SCHEMA_CHANGED",
          message: "Request shape outdated.",
          action: "Apply diff and retry.",
          requestId: "req_xyz",
          rev: "2026-05-13.1",
          diff: [
            { op: "add", path: "/claims/0/falsifiableBy", required: true },
          ],
        },
      },
      rawText: "",
      status: 422,
      fallbackAction: "fallback",
    });
    expect(args.code).toBe("SCHEMA_CHANGED");
    expect(args.details).toBeDefined();
    expect((args.details as Record<string, unknown>).rev).toBe("2026-05-13.1");
    expect((args.details as Record<string, unknown>).diff).toEqual([
      { op: "add", path: "/claims/0/falsifiableBy", required: true },
    ]);

    const wire = JSON.parse(new StructuredMCPError(args).message) as Record<
      string,
      unknown
    >;
    expect((wire.details as Record<string, unknown>).diff).toBeDefined();
  });

  it("preserves details.fieldErrors for VALIDATION_ERROR", () => {
    const args = parseBackendErrorEnvelope({
      data: {
        error: {
          code: "VALIDATION_ERROR",
          message: "summary too long; falsifiableBy required.",
          action:
            "Fix: summary max 1000 chars (sent 1247); claims[0].falsifiableBy required. Retry.",
          requestId: "req_v1",
          fieldErrors: [
            { field: "summary", code: "TOO_LONG", fix: "max 1000 chars" },
            {
              field: "claims[0].falsifiableBy",
              code: "REQUIRED",
              fix: "non-empty string",
            },
          ],
        },
      },
      rawText: "",
      status: 422,
      fallbackAction: "fallback",
    });
    expect(args.details).toBeDefined();
    const fieldErrors = (args.details as Record<string, unknown>)
      .fieldErrors as Array<Record<string, unknown>>;
    expect(fieldErrors).toHaveLength(2);
    expect(fieldErrors[0].field).toBe("summary");
  });

  it("accepts legacy snake_case request_id as a fallback", () => {
    const args = parseBackendErrorEnvelope({
      data: {
        error: {
          code: "AGENT_RESTRICTED",
          message: "blocked",
          action: "lift the restriction",
          request_id: "req_legacy",
        },
      },
      rawText: "",
      status: 403,
      fallbackAction: "fallback",
    });
    expect(args.requestId).toBe("req_legacy");
  });

  it("falls back to HTTP_<status> when body is not a JSON envelope", () => {
    const args = parseBackendErrorEnvelope({
      data: { _rawBody: "<html>502 Bad Gateway</html>" },
      rawText: "<html>502 Bad Gateway</html>",
      status: 502,
      fallbackAction: "fallback",
    });
    expect(args.code).toBe("HTTP_502");
    expect(args.message).toContain("502 Bad Gateway");
    expect(args.requestId).toBeUndefined();
    expect(args.httpStatus).toBe(502);
  });

  it("uses AUTH_HTTP_ prefix for auth-flow synthetic codes", () => {
    const args = parseBackendErrorEnvelope({
      data: {},
      rawText: "",
      status: 503,
      codePrefix: "AUTH_HTTP_",
      fallbackAction: "fallback",
    });
    expect(args.code).toBe("AUTH_HTTP_503");
  });
});

// ── Regression fences for MCP audit hotfixes (2026-05-20) ──────────

describe("claim_payout — recipient binding (#613)", () => {
  const claimBlock = sliceBetween(
    SERVER_TS,
    "Router enforces one claim per (qid, recipient)",
    "await awaitReceipt(publicClient, txHash);",
  );

  it("passes recipient explicitly to broadcastClaim", () => {
    expect(
      claimBlock,
      "broadcastClaim must pass recipient — Merkle leaf binds (qid, recipient, amount); omitting it reverts on chain",
    ).toMatch(/recipient:\s*address\b/);
  });

  it("includes a proof fingerprint in the idempotency cache key", () => {
    expect(
      claimBlock,
      "claim_payout cache key must include proofFingerprint(proof) so power-user overrides don't collide",
    ).toMatch(/proofKey:\s*proofFingerprint\(proof\)/);
  });
});

describe("idempotency cache hygiene (#614)", () => {
  it("uses canonicalStringify for cache key derivation", () => {
    expect(
      SERVER_TS,
      "idempotencyKey must use canonicalStringify so key order doesn't break the cache",
    ).toMatch(/function idempotencyKey[\s\S]+?canonicalStringify\(params\)/);
  });

  it("imports canonicalStringify from the shared intents helper", () => {
    // Drift fence: a local re-definition would shadow the canonical
    // (bigint/NaN-safe) version with a weaker variant. claim_payout
    // params include bigint-derived strings; the commit content body
    // is nested user content — both rely on the shared strictness.
    expect(SERVER_TS).toMatch(
      /from\s+"\.\.\/\.\.\/src\/intents\/commit-intent\.js"/,
    );
    expect(SERVER_TS, "must not redefine canonicalStringify locally").not
      .toMatch(/^function canonicalStringify/m);
  });

  it("prunes the idempotency cache to avoid unbounded growth", () => {
    expect(
      SERVER_TS,
      "setCached must invoke periodic prune via pruneIdempotencyCache",
    ).toMatch(/pruneIdempotencyCache\(\)/);
    expect(
      SERVER_TS,
      "cache must have a hard size cap (IDEM_CACHE_MAX_ENTRIES)",
    ).toMatch(/IDEM_CACHE_MAX_ENTRIES/);
  });
});

function sliceBetween(haystack: string, start: string, end: string): string {
  const i = haystack.indexOf(start);
  const j = haystack.indexOf(end, i);
  if (i < 0 || j < 0) return "";
  return haystack.slice(i, j + end.length);
}
