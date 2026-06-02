// social/index.ts — the share spine.
//
// Every confirmed action is a chance to DEMONSTRATE polished intelligence, not
// announce a chore. composeShare leads with the substance (the claim, forecast,
// or judgment), then a brand-voice frame, then a link-back to the question — so
// the post is itself a sample of the product and a funnel into it. The voice
// frame is a .local-overridable card (each operator's swarm sounds distinct but
// all push @ReZonTree). Sinks are pluggable; nothing leaves the machine unless
// the operator explicitly opts in (RT_SOCIAL_SHARE=1) — a stray run never posts.

import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCard } from "../skills/load.js";
import { sanitizeForPost, withReferral, type Referral } from "./growth.js";

/** Webhook egress timeout — a hung/black-hole webhook must not stall an agent. */
const WEBHOOK_TIMEOUT_MS = 5000;

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ShareAction = "ask" | "solve" | "vote" | "cosponsor";

export interface ShareContext {
  action: ShareAction;
  agent: string;
  questionId: string;
  questionTitle: string;
  /** link-back to the question — the funnel. */
  url?: string;
  /** the substance — the claim / forecast / judgment that DEMONSTRATES quality. */
  insight?: string;
  /** for vote/forecast shares. */
  probability?: number;
}

export interface SharePost {
  action: ShareAction;
  text: string;
  url?: string;
}

/** What a flow knows at confirmation time — the swarm adds the url + voice. */
export type ShareEvent = Omit<ShareContext, "url">;

/** The brand-voice frame — the @ReZonTree pitch + CTA. Loaded from the
 *  `.local`-overridable card so each operator can set a distinct voice. */
export function loadVoice(): string {
  return loadCard("share-voice", [__dirname]).trim();
}

/** The demonstration line — substance first. Uses the agent's insight when it
 *  has one; otherwise a quality-framed default. This is what markets by SHOWING. */
function demonstrationLine(c: ShareContext): string {
  const t = c.questionTitle.trim() || "an open question";
  switch (c.action) {
    case "ask":
      return `New on @ReZonTree — "${t}". ${c.insight ?? "A hard problem worth the sharpest reasoning. Crowdsourcing a precise, falsifiable answer."}`;
    case "solve":
      return `${c.insight ?? `Argued a falsifiable, evidence-backed answer to "${t}".`} Staked it, open to adversarial peer review.`;
    case "vote": {
      const p = c.probability != null ? ` P(winner)≈${c.probability}.` : "";
      return `Judged the field on "${t}" and backed the most-probable answer.${p} ${c.insight ?? ""}`.trim();
    }
    case "cosponsor":
      return `Raised the bounty on "${t}" — this problem deserves more eyes and better answers.`;
  }
}

/** Pure: compose the post from an action + the brand voice. Untrusted fields
 *  (backend title, agent insight, url) are sanitized — no injected newlines /
 *  control chars / unbounded length reach the post. */
export function composeShare(ctx: ShareContext, voice: string = loadVoice()): SharePost {
  const safe: ShareContext = {
    ...ctx,
    questionTitle: sanitizeForPost(ctx.questionTitle, 200),
    insight: ctx.insight ? sanitizeForPost(ctx.insight, 400) : undefined,
    url: ctx.url ? sanitizeForPost(ctx.url, 300) : undefined,
  };
  const lead = demonstrationLine(safe);
  const link = safe.url ? `\n${safe.url}` : "";
  return { action: safe.action, url: safe.url, text: `${lead}\n\n${voice}${link}`.trim() };
}

// ── Sinks ────────────────────────────────────────────────────────
export interface ShareSink {
  emit(post: SharePost): Promise<void>;
}

/** Print locally — not a real post; the safe default when sharing is on. */
export function stdoutSink(): ShareSink {
  return { emit: async (p) => void console.log(`\n[share:${p.action}]\n${p.text}\n`) };
}

/** Append one JSONL record per post to a local log. */
export function fileSink(path: string): ShareSink {
  return { emit: async (p) => void appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...p }) + "\n") };
}

/** POST to a webhook (a real social bridge lives behind this). External egress. */
export function webhookSink(url: string, fetchImpl: typeof fetch = fetch): ShareSink {
  return {
    emit: async (p) => {
      await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS), // never let a hung webhook stall the agent
      });
    },
  };
}

/** Resolve a sink from env. OPT-IN: returns undefined (no sharing) unless
 *  RT_SOCIAL_SHARE=1 — so a default run never posts anywhere, even stdout. */
export function resolveSink(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ShareSink | undefined {
  if (env.RT_SOCIAL_SHARE !== "1") return undefined;
  switch (env.RT_SOCIAL_SINK ?? "stdout") {
    case "none":
      return undefined;
    case "file":
      return fileSink(env.RT_SOCIAL_FILE ?? "social-shares.log");
    case "webhook": {
      const url = env.RT_SOCIAL_WEBHOOK_URL;
      if (!url) throw new Error("RT_SOCIAL_SINK=webhook requires RT_SOCIAL_WEBHOOK_URL");
      return webhookSink(url, fetchImpl);
    }
    default:
      return stdoutSink();
  }
}

/** Compose + emit. The after-action hook the flows call on every confirmed
 *  action. A configured referral appends its CTA (the funnel); none ⇒ no-op. */
export async function shareAfterAction(ctx: ShareContext, sink: ShareSink, voice?: string, referral?: Referral): Promise<void> {
  const post = composeShare(ctx, voice);
  await sink.emit(referral ? withReferral(post, referral) : post);
}
