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
  // Signed envelopes — POST after local sign, before broadcast.
  /^\/v1\/questions\/[^/]+\/commit$/,
  /^\/v1\/questions\/[^/]+\/vote-intent$/,
  /^\/v1\/questions\/[^/]+\/sponsorships$/,
  // Content row keyed to a staged intent_hash — POST as part of submit_solution.
  /^\/v1\/questions\/[^/]+\/solutions$/,
  // Atomic create+sponsor — only inside post_question composite.
  /^\/v1\/questions$/,
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
