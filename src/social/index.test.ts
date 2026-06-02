import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { composeShare, resolveSink, shareAfterAction, webhookSink, type ShareContext } from "./index.js";

const VOICE = "Sharpened on @ReZonTree. #RezonTree";
const ctx = (over: Partial<ShareContext> = {}): ShareContext => ({
  action: "solve",
  agent: "alice",
  questionId: "qst_1",
  questionTitle: "Will it rain in Dubai before 2027?",
  url: "https://rezontree.com/questions/qst_1",
  ...over,
});

describe("composeShare", () => {
  it("leads with the substance, then the brand voice, then the link-back", () => {
    const p = composeShare(ctx({ action: "solve", insight: "Base rate 12%, adjusting to P=0.41." }), VOICE);
    const leadAt = p.text.indexOf("Base rate 12%");
    const voiceAt = p.text.indexOf("@ReZonTree");
    const urlAt = p.text.indexOf("https://rezontree.com");
    expect(leadAt).toBeGreaterThanOrEqual(0);
    expect(voiceAt).toBeGreaterThan(leadAt); // voice after substance
    expect(urlAt).toBeGreaterThan(voiceAt); // funnel last
  });

  it("demonstrates per action — not a bare 'I voted'", () => {
    expect(composeShare(ctx({ action: "ask" }), VOICE).text).toMatch(/New on @ReZonTree/);
    expect(composeShare(ctx({ action: "vote", probability: 0.42, insight: "non-consensus read holds." }), VOICE).text).toMatch(/P\(winner\)≈0\.42.*non-consensus/s);
    expect(composeShare(ctx({ action: "cosponsor" }), VOICE).text).toMatch(/Raised the bounty/);
    // never just an announcement
    expect(composeShare(ctx({ action: "vote" }), VOICE).text).not.toMatch(/^I voted/);
  });
});

describe("resolveSink — opt-in gate", () => {
  it("returns undefined (no sharing) unless RT_SOCIAL_SHARE=1", () => {
    expect(resolveSink({})).toBeUndefined();
    expect(resolveSink({ RT_SOCIAL_SINK: "stdout" })).toBeUndefined(); // sink set but not opted in
    expect(resolveSink({ RT_SOCIAL_SHARE: "1" })).toBeDefined(); // default stdout once opted in
  });

  it("selects file/webhook, and webhook requires a URL", () => {
    expect(resolveSink({ RT_SOCIAL_SHARE: "1", RT_SOCIAL_SINK: "none" })).toBeUndefined();
    expect(() => resolveSink({ RT_SOCIAL_SHARE: "1", RT_SOCIAL_SINK: "webhook" })).toThrow(/RT_SOCIAL_WEBHOOK_URL/);
  });
});

describe("sinks", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("file sink appends a JSONL record", async () => {
    dir = mkdtempSync(join(tmpdir(), "rt-social-"));
    const path = join(dir, "shares.log");
    const sink = resolveSink({ RT_SOCIAL_SHARE: "1", RT_SOCIAL_SINK: "file", RT_SOCIAL_FILE: path })!;
    await shareAfterAction(ctx({ action: "ask" }), sink, VOICE);
    const rec = JSON.parse(readFileSync(path, "utf8").trim());
    expect(rec.action).toBe("ask");
    expect(rec.text).toContain("@ReZonTree");
  });

  it("webhook sink POSTs the composed post", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    const sink = webhookSink("https://hook.test/x", fetchMock as unknown as typeof fetch);
    await shareAfterAction(ctx({ action: "solve" }), sink, VOICE);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string).action).toBe("solve");
  });
});
