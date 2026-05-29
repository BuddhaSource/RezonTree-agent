// redact.test.ts — behavioral tests for the shared credential redactor.
// Shared by both the MCP server (mcp-servers/protocol-api/server.ts)
// and the SDK flow helpers (src/forge/quadphase-flow.ts). Audit C2
// found the SDK was missing this redaction in its 7 error-throw sites;
// this test locks the behavior so a regression in either consumer
// shows up immediately.

import { describe, it, expect } from "vitest";
import { redactBearer } from "./redact.js";

describe("redactBearer", () => {
  it("strips `Bearer <token>` substrings", () => {
    const sample =
      "upstream proxy log: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig leaked";
    expect(redactBearer(sample)).toBe(
      "upstream proxy log: Authorization: Bearer <redacted> leaked",
    );
  });

  it("strips bare JWT prefixes that aren't preceded by `Bearer`", () => {
    // A token logged solo (e.g. printf-debug residue) still leaks.
    const sample =
      "token=eyJabcdefghijklmnopqrstuvwxyz.payload.signature_here in old log";
    expect(redactBearer(sample)).toBe("token=<redacted-jwt> in old log");
  });

  it("leaves non-bearer strings untouched", () => {
    expect(redactBearer("normal error: HTTP 500 timeout")).toBe(
      "normal error: HTTP 500 timeout",
    );
  });

  it("redacts multiple bearer occurrences in one string", () => {
    const sample =
      "tried Bearer eyJaaaa.bbbb.cccc then retried Bearer eyJdddd.eeee.ffff";
    expect(redactBearer(sample)).toBe(
      "tried Bearer <redacted> then retried Bearer <redacted>",
    );
  });
});

describe("SDK flow helpers (src/forge/quadphase-flow.ts) redaction contract", () => {
  // Source-level assertion mirroring the MCP server.test.ts pattern.
  // Locks the post-audit-C2 invariant: every flow-helper error throw
  // that interpolates a response body must redact first.
  it("all backend-POST error throws wrap the body in redactBearer()", async () => {
    const { readFile } = await import("node:fs/promises");
    const flowSrc = await readFile(
      new URL("../forge/quadphase-flow.ts", import.meta.url),
      "utf-8",
    );
    // The pattern `...failed: HTTP ... ${text}` is the BEFORE state;
    // the new pattern uses redactBearer(text). Assert ZERO occurrences
    // of the raw form.
    const rawForm = /failed: HTTP \$\{res\.status\} \$\{res\.statusText\}: \$\{text\}\`/g;
    const matches = flowSrc.match(rawForm) ?? [];
    expect(
      matches.length,
      "any quadphase-flow.ts error throw interpolating raw text without redactBearer leaks JWTs via misconfigured upstream proxies",
    ).toBe(0);
    // And that the redacted form is present at least once (sanity).
    expect(flowSrc).toMatch(/redactBearer\(text\)/);
  });

  it("runAbandonFlow stages the row in the backend before broadcast (audit C1)", async () => {
    const { readFile } = await import("node:fs/promises");
    const flowSrc = await readFile(
      new URL("../forge/quadphase-flow.ts", import.meta.url),
      "utf-8",
    );
    const abandonStart = flowSrc.indexOf("export async function runAbandonFlow");
    expect(abandonStart, "runAbandonFlow must exist").toBeGreaterThan(-1);
    const refundStart = flowSrc.indexOf("export async function runRefundFlow");
    const abandonBody = flowSrc.slice(abandonStart, refundStart);
    // Backend POST is the C1 fix — without it the chain Abandon event
    // arrives with no staged signed_intents row to JOIN, the
    // reconciler routes it to OutcomeHeld, and the question's DB
    // status stays `open` even though the chain says `Abandoned`.
    expect(
      abandonBody,
      "runAbandonFlow must POST to /v1/questions/:id/intents before broadcastAbandonSubmit (audit C1)",
    ).toMatch(/POST.*\/v1\/questions/);
    expect(abandonBody).toMatch(/actionType: "abandon"/);
    // And the POST must precede broadcastAbandonSubmit, not follow it.
    // Abandon broadcasts via the witness-bearing `abandonSubmit(env, sig,
    // witnessBytes)` entry — plain `submit()` reverts
    // "submit:abandon-needs-witness" for an Abandon envelope.
    const postIdx = abandonBody.indexOf("/v1/questions/");
    const broadcastIdx = abandonBody.indexOf("broadcastAbandonSubmit(");
    expect(
      broadcastIdx,
      "runAbandonFlow must broadcast via broadcastAbandonSubmit (witness-bearing abandonSubmit entry)",
    ).toBeGreaterThan(-1);
    expect(
      postIdx,
      "POST must happen before broadcastAbandonSubmit (chain emits event → reconciler needs the row already staged)",
    ).toBeLessThan(broadcastIdx);
  });

  it("runRefundFlow validates sourceIntentHash is bytes32 at entry (audit H2)", async () => {
    const { readFile } = await import("node:fs/promises");
    const flowSrc = await readFile(
      new URL("../forge/quadphase-flow.ts", import.meta.url),
      "utf-8",
    );
    // Find the BYTES32_RE definition.
    expect(flowSrc).toMatch(/BYTES32_RE\s*=\s*\/\^0x\[0-9a-fA-F\]\{64\}\$\//);
    // Find the validator at the top of runRefundFlow.
    const refundStart = flowSrc.indexOf("export async function runRefundFlow");
    const claimStart = flowSrc.indexOf("export async function runClaimFlow");
    const refundBody = flowSrc.slice(refundStart, claimStart);
    expect(
      refundBody,
      "runRefundFlow must guard sourceIntentHash with BYTES32_RE (audit H2)",
    ).toMatch(/BYTES32_RE\.test\(p\.sourceIntentHash\)/);
  });

  it("serializeEnvelope routes expiresAt through encodeBigIntForWire (audit H1)", async () => {
    const { readFile } = await import("node:fs/promises");
    const flowSrc = await readFile(
      new URL("../forge/quadphase-flow.ts", import.meta.url),
      "utf-8",
    );
    // The fix replaces `expiresAt: Number(e.expiresAt)` with
    // `expiresAt: encodeBigIntForWire(e.expiresAt)`. Assert ZERO
    // occurrences of the lossy Number() form.
    expect(
      flowSrc,
      "serializeEnvelope must use encodeBigIntForWire, not Number() — audit H1",
    ).not.toMatch(/expiresAt:\s*Number\(e\.expiresAt\)/);
    expect(flowSrc).toMatch(/expiresAt:\s*encodeBigIntForWire\(e\.expiresAt\)/);
  });
});
