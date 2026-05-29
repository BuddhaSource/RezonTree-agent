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

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  StructuredMCPError,
  classifyRetryable,
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
  "withdraw",
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
  // Confirmation watch — block until the reconciler reaches terminal
  // state on an intent_hash the agent just broadcast. Local because the
  // agent's prior tool call (submit_solution / cast_vote / etc.) already
  // holds the wallet + JWT context this poll uses.
  "wait_for_chain_confirmation",
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
  // Round-3 unified preflight — POST body discriminates action via
  // `actionType` (sponsor / cosponsor / commit / vote / claim / refund
  // / settle / abandon). Backend authors canonical params +
  // expectedIntentHash.
  /^\/v1\/questions\/[^/]+\/intents\/preflight(\?|$)/,
  // Round-3 unified submit — universal signed-envelope POST that
  // replaced /v1/questions/:id/{commit,vote-intent,sponsorships,
  // claims,refunds} and /v1/quadphase/submit. Same contract
  // (sign-then-POST-then-broadcast); the SDK posts {actionType,
  // typedData, signature, expectedIntentHash, content} here, then
  // broadcasts submit()/sponsorSubmit().
  /^\/v1\/questions\/[^/]+\/intents(\?|$)/,
  // Atomic create — only inside post_question composite.
  /^\/v1\/questions$/,
  // Question detail — used by fund_question's sponsor-mode orphan-draft
  // recovery to reload title + body so the SponsorWitness content hash
  // matches what post_question would have emitted.
  /^\/v1\/questions\/[^/]+$/,
  // Account-include fetch — wait_for_chain_confirmation polls
  // `/v1/accounts/me?include=pending` to block until the reconciler
  // reaches terminal state on an intent the agent just broadcast. The
  // local MCP keeps this call because it pairs with the wallet + JWT
  // context the prior sign-and-broadcast tool call already holds.
  /^\/v1\/accounts\/[^/]+(\?|$)/,
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

describe("withdraw — unified money-out door", () => {
  const withdrawBlock = sliceBetween(
    SERVER_TS,
    'server.tool(\n  "withdraw"',
    "// ── Wallet ──",
  );

  it("preflights the unified door with actionType:'withdraw'", () => {
    expect(
      withdrawBlock,
      "withdraw must POST /intents/preflight with {actionType:'withdraw'} — the preflight-only discovery door",
    ).toMatch(/actionType:\s*"withdraw"/);
    expect(withdrawBlock).toMatch(/\/intents\/preflight/);
  });

  it("treats an empty eligible list as success, not an error", () => {
    // eligible:[] / eligibleCount:0 is a valid 200 = owed nothing. The
    // tool must return a textResponse (success), never throw.
    expect(
      withdrawBlock,
      "empty eligible list must short-circuit to a success result echoing questionStatus",
    ).toMatch(/items\.length\s*===\s*0/);
    expect(withdrawBlock).toMatch(/eligible_count:\s*0/);
  });

  it("uses each draft's server-allocated nonce + expectedIntentHash verbatim", () => {
    // R-INTENT-HASH-IS-MATCH-KEY: the withdraw door pre-allocates a
    // distinct RANDOM nonce per item; the SDK MUST pass it (and the
    // pinned expectedIntentHash) through unchanged — never recompute.
    expect(
      withdrawBlock,
      "claim leg must feed the draft's nonce verbatim",
    ).toMatch(/nonce:\s*BigInt\(c\.nonce\)/);
    expect(withdrawBlock).toMatch(/nonce:\s*BigInt\(r\.nonce\)/);
    expect(
      withdrawBlock,
      "both legs must pass the draft's expectedIntentHash so runClaim/RefundFlow can assert no drift before signing",
    ).toMatch(/expectedIntentHash:\s*c\.expectedIntentHash/);
    expect(withdrawBlock).toMatch(/expectedIntentHash:\s*r\.expectedIntentHash/);
  });

  it("keys per-item idempotency so one item can't replay another's tx", () => {
    // Mirrors the #614 claim_payout idempotency pattern: claim keyed on
    // leafIndex, refund keyed on sourceIntentHash — so a re-call retries
    // only the unfinished items.
    expect(withdrawBlock).toMatch(/leafIndex:\s*item\.claim\.leafIndex/);
    expect(withdrawBlock).toMatch(
      /sourceIntentHash:\s*item\.refund\.sourceIntentHash/,
    );
  });

  it("recovers the bounty token from envelopeTemplate.envelope.funds.token", () => {
    // The draft has no top-level token field; it's nested in the signed
    // envelope the backend hashed. tokenFromTemplate must read it there
    // and fail loud (not sign a zero token) when absent.
    expect(SERVER_TS).toMatch(/envelopeTemplate\?\.envelope/);
    expect(SERVER_TS).toMatch(/funds\?\.token/);
  });

  it("one item failing does not abort the others", () => {
    // Per-item try/catch records a failed status and continues the loop;
    // it must NOT rethrow out of the for-loop.
    expect(withdrawBlock).toMatch(/status:\s*"failed"/);
    expect(withdrawBlock).toMatch(/failures\+\+/);
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
    // (bigint/NaN-safe) version with a weaker variant. withdraw cache
    // keys include bigint-derived strings (leafIndex, nonce); the commit
    // content body is nested user content — both rely on the shared
    // strictness.
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

// ── MCP security cluster (#617) ─────────────────────────────────────
//
// Source-level fences for the five hardening items shipped together.
// Each test pins the load-bearing token / line so a future refactor
// can't silently regress the fix without breaking CI.

describe("MCP security cluster (#617)", () => {
  it("(1) path traversal: validates question_id shape before URL interpolation", () => {
    expect(
      SERVER_TS,
      "every signed-flow tool must assertQuestionId before interpolating into the URL",
    ).toMatch(/assertQuestionId\(params\.question_id\)/);
    // The validator itself must reject the traversal characters.
    expect(SERVER_TS).toMatch(/const QID_RE = \/\^\[a-z\]\{3\}_\[0-9A-Za-z\]\{1,64\}\$\//);
    // Each load-bearing tool calls it.
    const tools = [
      "submit_solution",
      "cast_vote",
      "fund_question",
      "withdraw",
    ];
    for (const t of tools) {
      const sliced = SERVER_TS.slice(SERVER_TS.indexOf(`"${t}"`));
      expect(
        sliced.indexOf("assertQuestionId"),
        `${t} must call assertQuestionId at boundary`,
      ).toBeGreaterThan(-1);
    }
  });

  it("(2) JWT leakage: redactBearer strips Bearer tokens from surfaced strings", async () => {
    // server.ts imports redactBearer from the shared util at
    // src/utils/redact.ts (refactor lifted it out so the SDK flow
    // helpers in src/forge/quadphase-flow.ts can also redact their
    // error throws — same threat, same surface). Lock the contract
    // by checking BOTH the import wiring AND its usage in apiCall.
    expect(SERVER_TS).toMatch(
      /import\s*\{\s*redactBearer\s*\}\s*from\s*["']\.\.\/\.\.\/src\/utils\/redact\.js["']/,
    );
    // The non-2xx surfacer redacts rawText.
    expect(
      SERVER_TS,
      "apiCall must redact rawText before piping into the error envelope",
    ).toMatch(/rawText: redactBearer\(rawText\)/);
    // The _rawBody fallback redacts too.
    expect(SERVER_TS).toMatch(/_rawBody: redactBearer\(rawText\)/);
  });

  it("(2b) JWT leakage: redactBearer logic actually strips a real-looking token", () => {
    // Re-implement the regex behavior here to lock the contract.
    const sample =
      "upstream proxy log: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig leaked";
    const expected =
      "upstream proxy log: Authorization: Bearer <redacted> leaked";
    const re = /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g;
    expect(sample.replace(re, "Bearer <redacted>")).toBe(expected);
  });

  it("(3) BigInt sentinel: safeJSONStringify encodes bigints without throwing", () => {
    expect(
      SERVER_TS,
      "textResponse must funnel responses through safeJSONStringify",
    ).toMatch(/safeJSONStringify\(result\)/);
    expect(SERVER_TS).toMatch(/typeof v === "bigint"/);
    // Replicate the replacer to assert it doesn't throw on a tool
    // body that forgot .toString() on a bigint.
    const result = JSON.stringify(
      { amount: 12345n, nested: { fee: 999n } },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(result).toContain('"amount":"12345"');
    expect(result).toContain('"fee":"999"');
  });

  it("(4) JSON.parse robustness: voting_deadline is loud-failed if unparseable", () => {
    // assertion lives in post_question tool body
    const postQuestion = SERVER_TS.slice(
      SERVER_TS.indexOf('"post_question"'),
    );
    expect(postQuestion).toMatch(/Number\.isFinite\(deadlineMs\)/);
    expect(postQuestion).toMatch(/STRUCTURED_INPUT_INVALID/);
  });

  it("(4b) JSON.parse robustness: both apiCall JSON.parse sites have try/catch", () => {
    // Count the JSON.parse occurrences and the surrounding try { … } catch.
    const sites = [...SERVER_TS.matchAll(/JSON\.parse\(rawText\)/g)];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    // Each one must be reachable from a `try {` within 200 chars before.
    for (const m of sites) {
      const start = Math.max(0, (m.index ?? 0) - 200);
      const ctx = SERVER_TS.slice(start, m.index);
      expect(ctx.includes("try {")).toBe(true);
    }
  });

  it("(5) cache leak: seenQuestionIds is bounded by SEEN_QUESTION_IDS_MAX", () => {
    expect(SERVER_TS).toMatch(/SEEN_QUESTION_IDS_MAX\s*=\s*\d+/);
    expect(SERVER_TS).toMatch(/function rememberSeenQuestion/);
    // wait_for_questions must use the bounded helper, not raw .add().
    const wait = SERVER_TS.slice(SERVER_TS.indexOf('"wait_for_questions"'));
    const endRel = wait.search(/^\);/m);
    const waitBody = wait.slice(0, endRel);
    expect(
      waitBody,
      "wait_for_questions must call rememberSeenQuestion, not raw seenQuestionIds.add",
    ).not.toMatch(/seenQuestionIds\.add\b/);
    expect(waitBody).toMatch(/rememberSeenQuestion\(/);
  });

  it("(5b) cache leak: eviction loop trims oldest entry on overflow", () => {
    // Lock the eviction implementation so a refactor can't silently
    // remove the cap.
    expect(SERVER_TS).toMatch(
      /while \(seenQuestionIds\.size > SEEN_QUESTION_IDS_MAX\)/,
    );
  });
});

// ── #616 — agent friction fixes ─────────────────────────────────────
//
// Three load-bearing fixes shipped together: canonical sort param,
// wait_for_chain_confirmation tool, retryable envelope field. Each
// gets a fence so a future refactor can't silently regress.

describe("#616 wait_for_questions sort param", () => {
  it("uses canonical sort=created_at (no :desc suffix)", () => {
    // Backend Round-3 GET /v1/questions accepts sort ∈ {created_at,
    // initial_bounty, solution_count}. The historical bug was
    // `created_at:desc` (audit drift-2026-05-21 §03 line 69).
    expect(SERVER_TS).toMatch(/sort=created_at(?!:)/);
    expect(SERVER_TS, "must not send sort=created_at:desc").not.toMatch(
      /sort=created_at:desc/,
    );
  });

  it("reads canonical Round-3 list shape (data) only", () => {
    const wait = SERVER_TS.slice(SERVER_TS.indexOf('"wait_for_questions"'));
    const endRel = wait.search(/^\);/m);
    const waitBody = wait.slice(0, endRel);
    // Round-3 list response is `{data, cursor?, hasMore}`. The dead
    // `items?` probe + `q.questionId` + `q.author_address` fallbacks
    // were stale pre-Round-3 shapes (audit drift-2026-05-21 §03).
    // Strip comments before pattern-matching so the call-out we leave
    // *in* the source ("`items?` probe is stale") doesn't trip the
    // grep that's looking for actual code.
    const codeOnly = waitBody.replace(/\/\/[^\n]*\n/g, "\n");
    expect(codeOnly, "items? probe is stale").not.toMatch(/\bitems\?:/);
    expect(codeOnly, "questionId fallback is stale").not.toMatch(
      /q\.questionId/,
    );
    expect(
      codeOnly,
      "author_address snake_case fallback is stale",
    ).not.toMatch(/q\.author_address/);
  });
});

describe("#616 wait_for_chain_confirmation", () => {
  const block = SERVER_TS.slice(
    SERVER_TS.indexOf('"wait_for_chain_confirmation"'),
  );
  const endRel = block.search(/^\);/m);
  const toolBody = block.slice(0, endRel);

  it("validates intent_hash shape at the boundary", () => {
    expect(toolBody).toMatch(/assertBytes32\(params\.intent_hash/);
  });

  it("polls the canonical pending surface", () => {
    expect(toolBody).toMatch(
      /apiCall\(\s*"GET"\s*,\s*"\/v1\/accounts\/me\?include=pending"/,
    );
  });

  it("surfaces Stage-4 rejection as WAIT_CONFIRMATION_REJECTED", () => {
    expect(toolBody).toMatch(/lifecyclePhase === "rejected_revalidation"/);
    expect(toolBody).toMatch(/WAIT_CONFIRMATION_REJECTED/);
  });

  it("times out as WAIT_CONFIRMATION_TIMEOUT with retryable=true", () => {
    expect(toolBody).toMatch(/WAIT_CONFIRMATION_TIMEOUT/);
    expect(toolBody).toMatch(/retryable:\s*true/);
  });
});

describe("#616 retryable error envelope", () => {
  it("emits retryable field on the wire", () => {
    const err = new StructuredMCPError({
      code: "HTTP_503",
      message: "transient upstream",
      action: "retry",
      httpStatus: 503,
    });
    const wire = JSON.parse(err.message) as Record<string, unknown>;
    expect(wire.retryable).toBe(true);
    expect(err.retryable).toBe(true);
  });

  it("classifies 5xx + transport flake as retryable", () => {
    expect(classifyRetryable({ code: "HTTP_502", httpStatus: 502 })).toBe(true);
    expect(classifyRetryable({ code: "HTTP_503", httpStatus: 503 })).toBe(true);
    expect(classifyRetryable({ code: "HTTP_504", httpStatus: 504 })).toBe(true);
    expect(classifyRetryable({ code: "AUTH_HTTP_503", httpStatus: 503 })).toBe(
      true,
    );
    expect(classifyRetryable({ code: "AUTH_TRANSPORT_FAILED" })).toBe(true);
    expect(classifyRetryable({ code: "HTTP_429", httpStatus: 429 })).toBe(true);
    expect(classifyRetryable({ code: "HTTP_408", httpStatus: 408 })).toBe(true);
  });

  it("classifies 4xx + local synthetic codes as NOT retryable", () => {
    expect(classifyRetryable({ code: "HTTP_400", httpStatus: 400 })).toBe(false);
    expect(classifyRetryable({ code: "HTTP_401", httpStatus: 401 })).toBe(false);
    expect(classifyRetryable({ code: "HTTP_403", httpStatus: 403 })).toBe(false);
    expect(classifyRetryable({ code: "HTTP_404", httpStatus: 404 })).toBe(false);
    expect(classifyRetryable({ code: "HTTP_409", httpStatus: 409 })).toBe(false);
    expect(classifyRetryable({ code: "HTTP_422", httpStatus: 422 })).toBe(false);
    expect(classifyRetryable({ code: "STRUCTURED_INPUT_INVALID" })).toBe(false);
    expect(classifyRetryable({ code: "AUTH_REFRESH_FAILED", httpStatus: 401 })).toBe(
      false,
    );
    expect(classifyRetryable({ code: "AUTH_CONFIG_MISSING" })).toBe(false);
    expect(classifyRetryable({ code: "INSUFFICIENT_BALANCE" })).toBe(false);
    expect(classifyRetryable({ code: "PREFLIGHT_MISSING_INTENT_HASH" })).toBe(
      false,
    );
    expect(classifyRetryable({ code: "WAIT_CONFIRMATION_REJECTED" })).toBe(
      false,
    );
  });

  it("explicit override beats default classification", () => {
    // Caller knows better — e.g. timeout error is retryable even though
    // WAIT_CONFIRMATION_TIMEOUT is in the permanent-local list (it would
    // be safer-default false). The override flips it on so the agent
    // calls back with a longer deadline.
    const err = new StructuredMCPError({
      code: "WAIT_CONFIRMATION_TIMEOUT",
      message: "still pending",
      action: "retry with larger max_wait_seconds",
      retryable: true,
    });
    expect(err.retryable).toBe(true);
  });

  it("backend envelope preserves retryable through parseBackendErrorEnvelope", () => {
    const args = parseBackendErrorEnvelope({
      data: {
        error: {
          code: "VALIDATION_ERROR",
          message: "bad input",
          action: "fix it",
        },
      },
      rawText: "",
      status: 422,
      fallbackAction: "fallback",
    });
    const err = new StructuredMCPError(args);
    expect(err.retryable).toBe(false);
    const wire = JSON.parse(err.message) as Record<string, unknown>;
    expect(wire.retryable).toBe(false);
  });

  it("unknown floor is NOT retryable (safe default)", () => {
    expect(classifyRetryable({ code: "MYSTERY_NEVER_SEEN" })).toBe(false);
  });
});

// ── token efficiency: GETs default to Prefer: return=minimal ─────────
//
// Source-text fence (matches this file's other drift fences). apiCall
// must add `Prefer: return=minimal` for GET requests by default, gated
// on a `verbose` opt-out — a list read shrinks ~75% with it, the
// headline token-efficiency win (parent CLAUDE.md API-consumption
// rule). Catches a regression that drops the header or applies it to
// every verb indiscriminately.
describe("token efficiency — apiCall Prefer:minimal default", () => {
  it("apiCall accepts a verbose opt-out flag", () => {
    expect(SERVER_TS).toMatch(/opts2\?\s*:\s*\{\s*verbose\??:\s*boolean\s*\}/);
  });

  it("apiCall sets Prefer: return=minimal for GETs unless verbose", () => {
    // The conditional + the header assignment must both be present.
    expect(SERVER_TS).toMatch(/isGet\s*&&\s*!opts2\?\.verbose/);
    expect(SERVER_TS).toMatch(/headers\.Prefer\s*=\s*"return=minimal"/);
  });

  it("isGet is derived from the method, not hard-coded", () => {
    expect(SERVER_TS).toMatch(
      /const\s+isGet\s*=\s*method\.toUpperCase\(\)\s*===\s*"GET"/,
    );
  });
});

// ── withdraw — BEHAVIORAL test (runtime draft→flow-param mapping) ─────
//
// The source-grep fences above ("withdraw — unified money-out door")
// catch a textual regression but never EXECUTE the tool: a logic bug
// that swaps leafAmount/leafIndex, drops expectedIntentHash, or
// recomputes the server-allocated nonce would still match the regex
// and pass. This block actually invokes the registered `withdraw`
// handler against a fabricated WithdrawDraftResponse (1 claim + 1
// refund) and asserts the EXACT args handed to runClaimFlow /
// runRefundFlow — the mapping class that previously cost real money
// ("MCP submit_solution drift cost ~$5 of burn").
//
// Seams used (no production code changed):
//   • vi.mock the chain/flow module boundary (src/forge/quadphase-flow,
//     src/forge/quadphase-broadcast) — matches the task's "vi.mock at
//     the module boundary" guidance. runClaimFlow/runRefundFlow become
//     spies that capture their single params object; awaitReceipt is a
//     no-op.
//   • vi.mock the stdio transport so server.ts's top-level
//     `await server.connect(transport)` resolves without touching real
//     stdio (server.ts connects on import — the only reason this needs
//     a module mock at all).
//   • vi.mock wallet derivation so getClients() yields a fake wallet
//     without a real mnemonic.
//   • stub global.fetch to answer the two real HTTP hops the handler
//     makes through its private apiCall/getAgentToken: POST /v1/sessions
//     (JWT issue) and POST …/intents/preflight (the withdraw draft).
//
// The handler is pulled off server._registeredTools["withdraw"].handler
// — the MCP SDK's registry — so we exercise the exact closure that ships.

const flowMocks = vi.hoisted(() => ({
  runClaimFlow: vi.fn(),
  runRefundFlow: vi.fn(),
  awaitReceipt: vi.fn(),
}));

vi.mock("../../src/forge/quadphase-flow.js", () => ({
  // Only runClaimFlow / runRefundFlow are exercised by withdraw; the
  // other exports (runCommitFlow, runVoteFlow, …) are imported by
  // server.ts at module scope, so they must exist as callables.
  runClaimFlow: flowMocks.runClaimFlow,
  runRefundFlow: flowMocks.runRefundFlow,
  runCommitFlow: vi.fn(),
  runVoteFlow: vi.fn(),
  runSponsorFlow: vi.fn(),
  runCosponsorFlow: vi.fn(),
  ensureUsdcAllowance: vi.fn(),
}));

// awaitReceipt + makeAgentWalletClient moved to quadphase-broadcast.js
// in the v2 cutover (#595, the deleted v1 client.js). server.ts imports
// them from there now, so the mock targets that module.
vi.mock("../../src/forge/quadphase-broadcast.js", () => ({
  awaitReceipt: flowMocks.awaitReceipt,
  makeAgentWalletClient: vi.fn(() => ({ account: { address: "0xwallet" } })),
}));

vi.mock("../../src/wallet/derive.js", () => ({
  deriveAgentWallet: vi.fn(() => ({
    agentIndex: 1,
    address: "0x1111111111111111111111111111111111111111",
    privateKey:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    chainId: 84532,
  })),
}));

// Stub the stdio transport so server.ts's top-level connect() resolves
// without binding real stdio. connect() assigns onclose/onerror/onmessage
// and awaits start(); a class with those slots + a resolving start()
// satisfies it.
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    onclose?: () => void;
    onerror?: (e: unknown) => void;
    onmessage?: (m: unknown) => void;
    async start() {
      /* no-op: nothing to bind in tests */
    }
    async send() {
      /* no-op */
    }
    async close() {
      /* no-op */
    }
  },
}));

describe("withdraw — behavioral draft→flow-param mapping", () => {
  // A claim leaf + a refund the backend would enumerate for a settled
  // question. Fields are deliberately distinct so a leafIndex/leafAmount
  // swap (or any field cross-wire) shows up as a wrong assertion value.
  const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  const CLAIM_DRAFT = {
    qid: "0xqidclaimqidclaimqidclaimqidclaimqidclaimqidclaimqidclaimqidclaim",
    recipient: "0x1111111111111111111111111111111111111111",
    leafIndex: "7",
    leafAmount: "250000",
    role: 1,
    proof: ["0xaaa", "0xbbb"],
    forgeAddress: "0xforge",
    chainId: 84532,
    nonce: "987654321987654321",
    nonceSource: "random",
    recommendedExpiresAt: 1746720000,
    expectedIntentHash:
      "0xCLAIMHASHCLAIMHASHCLAIMHASHCLAIMHASHCLAIMHASHCLAIMHASHCLAIMHASH00",
    envelopeTemplate: {
      envelope: { funds: { token: TOKEN } },
      witness: { expectedStatus: 3 },
      contentHash: "0xcontent",
      intentHash: "0xih",
      witnessTypehash: "0xwt",
      action: "Claim",
      actionTag: 0,
    },
    _actions: [],
  };

  const REFUND_DRAFT = {
    qid: "0xqidrefundqidrefundqidrefundqidrefundqidrefundqidrefundqidrefund0",
    signer: "0x1111111111111111111111111111111111111111",
    sourceIntentHash:
      "0xSOURCEHASHSOURCEHASHSOURCEHASHSOURCEHASHSOURCEHASHSOURCEHASH0000",
    expectedAmount: "100000",
    expectedStatus: 4,
    forgeAddress: "0xforge",
    chainId: 84532,
    nonce: "123123123123123123",
    nonceSource: "random",
    recommendedExpiresAt: 1746720500,
    expectedIntentHash:
      "0xREFUNDHASHREFUNDHASHREFUNDHASHREFUNDHASHREFUNDHASHREFUNDHASH0000",
    envelopeTemplate: {
      envelope: { funds: { token: TOKEN } },
      witness: {},
      contentHash: "0xcontent2",
      intentHash: "0xih2",
      witnessTypehash: "0xwt2",
      action: "Refund",
      actionTag: 0,
    },
    _actions: [],
  };

  // The withdraw handler keys its per-item idempotency cache on the
  // door qid + leafIndex/sourceIntentHash, and that cache is module-level
  // state surviving across tests. Give every test a UNIQUE door qid so a
  // prior test's cached claim/refund can never replay into a later one
  // (which would skip the runClaimFlow/runRefundFlow call we assert on).
  let doorQidSeq = 0;
  function draftWith(eligible: unknown[]) {
    const tag = `${doorQidSeq++}`.padStart(2, "0");
    return {
      qid: `0xDOORQID${tag}DOORQIDDOORQIDDOORQIDDOORQIDDOORQIDDOORQIDDOORQID00`,
      signer: "0x1111111111111111111111111111111111111111",
      questionStatus: "settled",
      eligible,
      eligibleCount: eligible.length,
      _actions: [],
    };
  }

  // currentDraft is swapped per-test; the fetch stub reads it so each
  // test controls what the preflight door returns.
  let currentDraft: ReturnType<typeof draftWith>;

  // The registered withdraw closure, pulled off the MCP registry.
  // biome-ignore lint/suspicious/noExplicitAny: handler signature is internal
  let withdrawHandler: (params: any) => Promise<any>;

  beforeAll(async () => {
    // server.ts reads these at module-eval time. Set before import.
    process.env.RT_FORGE_ADDRESS =
      "0x9999999999999999999999999999999999999999";
    process.env.RT_AGENT_MNEMONIC =
      "test test test test test test test test test test test junk";
    process.env.RT_AGENT_INDEX = "1";
    process.env.RT_RPC_URL = "http://localhost:8545";
    process.env.RT_AGENT_BACKEND_URL = "http://localhost:8080";
    process.env.RT_AGENT_CHAIN_ID = "84532";

    // Route the only two real HTTP hops the handler makes via its private
    // apiCall/getAgentToken. Everything else is module-mocked.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, _init?: unknown) => {
        const u = String(url);
        if (u.includes("/v1/sessions")) {
          return new Response(
            JSON.stringify({ accessToken: "test.jwt.token", expiresIn: 900 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.includes("/intents/preflight")) {
          return new Response(JSON.stringify(currentDraft), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch in withdraw test: ${u}`);
      }),
    );

    const mod = await import("./server.js");
    // server.ts exports the McpServer instance (a one-line test seam).
    // McpServer keeps registered tools in _registeredTools[name].handler.
    // biome-ignore lint/suspicious/noExplicitAny: SDK internal registry
    const server = (mod as any).server;
    expect(server, "server instance not exported from module").toBeDefined();
    const reg = server._registeredTools as Record<
      string,
      { handler: (params: unknown) => Promise<unknown> }
    >;
    expect(reg.withdraw, "withdraw tool not registered").toBeDefined();
    withdrawHandler = reg.withdraw.handler;
  });

  afterEach(() => {
    flowMocks.runClaimFlow.mockReset();
    flowMocks.runRefundFlow.mockReset();
    flowMocks.awaitReceipt.mockReset();
  });

  it("maps the claim draft → runClaimFlow args VERBATIM", async () => {
    currentDraft = draftWith([
      { actionType: "claim", role: "winner_creator", claim: CLAIM_DRAFT },
    ]);
    flowMocks.runClaimFlow.mockResolvedValue({
      intentHash: CLAIM_DRAFT.expectedIntentHash,
      txHash: "0xclaimtx",
    });

    const res = await withdrawHandler({ question_id: "qst_abc" });

    expect(flowMocks.runClaimFlow).toHaveBeenCalledTimes(1);
    const arg = flowMocks.runClaimFlow.mock.calls[0][0];

    // nonce + expectedIntentHash are the load-bearing pins: passed
    // VERBATIM, never recomputed. nonce is BigInt(draft.nonce).
    expect(arg.nonce).toBe(BigInt(CLAIM_DRAFT.nonce));
    expect(typeof arg.nonce).toBe("bigint");
    expect(arg.expectedIntentHash).toBe(CLAIM_DRAFT.expectedIntentHash);

    // leafIndex / leafAmount are the canonical swap-bug surface.
    expect(arg.leafIndex).toBe(BigInt(CLAIM_DRAFT.leafIndex));
    expect(arg.leafAmount).toBe(BigInt(CLAIM_DRAFT.leafAmount));

    // proof + role + expectedStatus from the witness.
    expect(arg.proof).toEqual(CLAIM_DRAFT.proof);
    expect(arg.role).toBe(CLAIM_DRAFT.role);
    expect(arg.expectedStatus).toBe(3); // witness.expectedStatus

    // token recovered from envelopeTemplate.envelope.funds.token.
    expect(arg.token).toBe(TOKEN);

    // qid / questionId routing.
    expect(arg.qid).toBe(CLAIM_DRAFT.qid);
    expect(arg.questionId).toBe("qst_abc");

    // expiresAt from the draft's recommendedExpiresAt (absolute Unix).
    expect(arg.expiresAt).toBe(BigInt(CLAIM_DRAFT.recommendedExpiresAt));

    // The handler awaits the receipt and reports success.
    expect(flowMocks.awaitReceipt).toHaveBeenCalledWith(
      expect.anything(),
      "0xclaimtx",
    );
    const body = JSON.parse(res.content[0].text);
    expect(body.eligible_count).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.total_withdrawn_wei).toBe(CLAIM_DRAFT.leafAmount);
  });

  it("maps the refund draft → runRefundFlow args VERBATIM", async () => {
    currentDraft = draftWith([
      { actionType: "refund", role: "sponsor", refund: REFUND_DRAFT },
    ]);
    flowMocks.runRefundFlow.mockResolvedValue({
      intentHash: REFUND_DRAFT.expectedIntentHash,
      txHash: "0xrefundtx",
    });

    const res = await withdrawHandler({ question_id: "qst_xyz" });

    expect(flowMocks.runRefundFlow).toHaveBeenCalledTimes(1);
    const arg = flowMocks.runRefundFlow.mock.calls[0][0];

    // VERBATIM pins.
    expect(arg.nonce).toBe(BigInt(REFUND_DRAFT.nonce));
    expect(typeof arg.nonce).toBe("bigint");
    expect(arg.expectedIntentHash).toBe(REFUND_DRAFT.expectedIntentHash);

    // Refund-specific mapping.
    expect(arg.sourceIntentHash).toBe(REFUND_DRAFT.sourceIntentHash);
    expect(arg.expectedAmount).toBe(BigInt(REFUND_DRAFT.expectedAmount));
    expect(arg.expectedStatus).toBe(REFUND_DRAFT.expectedStatus); // 4 = Abandoned

    // token from envelopeTemplate.envelope.funds.token.
    expect(arg.token).toBe(TOKEN);

    // qid / questionId routing + expiresAt.
    expect(arg.qid).toBe(REFUND_DRAFT.qid);
    expect(arg.questionId).toBe("qst_xyz");
    expect(arg.expiresAt).toBe(BigInt(REFUND_DRAFT.recommendedExpiresAt));

    expect(flowMocks.awaitReceipt).toHaveBeenCalledWith(
      expect.anything(),
      "0xrefundtx",
    );
    const body = JSON.parse(res.content[0].text);
    expect(body.eligible_count).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.total_withdrawn_wei).toBe(REFUND_DRAFT.expectedAmount);
  });

  it("drives BOTH legs in one call, each with its own verbatim nonce + hash", async () => {
    currentDraft = draftWith([
      { actionType: "claim", role: "winner_creator", claim: CLAIM_DRAFT },
      { actionType: "refund", role: "sponsor", refund: REFUND_DRAFT },
    ]);
    flowMocks.runClaimFlow.mockResolvedValue({
      intentHash: CLAIM_DRAFT.expectedIntentHash,
      txHash: "0xclaimtx",
    });
    flowMocks.runRefundFlow.mockResolvedValue({
      intentHash: REFUND_DRAFT.expectedIntentHash,
      txHash: "0xrefundtx",
    });

    const res = await withdrawHandler({ question_id: "qst_both" });

    const claimArg = flowMocks.runClaimFlow.mock.calls[0][0];
    const refundArg = flowMocks.runRefundFlow.mock.calls[0][0];

    // Each leg carries ITS OWN nonce + hash — not crossed, not shared.
    expect(claimArg.nonce).toBe(BigInt(CLAIM_DRAFT.nonce));
    expect(claimArg.expectedIntentHash).toBe(CLAIM_DRAFT.expectedIntentHash);
    expect(refundArg.nonce).toBe(BigInt(REFUND_DRAFT.nonce));
    expect(refundArg.expectedIntentHash).toBe(REFUND_DRAFT.expectedIntentHash);
    expect(claimArg.nonce).not.toBe(refundArg.nonce);

    const body = JSON.parse(res.content[0].text);
    expect(body.eligible_count).toBe(2);
    expect(body.succeeded).toBe(2);
    // total = claim leafAmount + refund expectedAmount.
    expect(body.total_withdrawn_wei).toBe(
      (BigInt(CLAIM_DRAFT.leafAmount) + BigInt(REFUND_DRAFT.expectedAmount)).toString(),
    );
  });

  it("empty eligible:[] returns a clean success (eligible_count:0), not a throw", async () => {
    currentDraft = draftWith([]);

    const res = await withdrawHandler({ question_id: "qst_empty" });

    // No flow function should fire on an empty list.
    expect(flowMocks.runClaimFlow).not.toHaveBeenCalled();
    expect(flowMocks.runRefundFlow).not.toHaveBeenCalled();

    const body = JSON.parse(res.content[0].text);
    expect(body.eligible_count).toBe(0);
    expect(body.withdrawn).toEqual([]);
    expect(body.total_withdrawn_wei).toBe("0");
    expect(body.question_status).toBe("settled");
  });
});
