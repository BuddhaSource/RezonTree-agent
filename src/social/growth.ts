// social/growth.ts — the growth engine: turn each share into a funnel.
//
// Pure generators, each pointed at a product metric:
//   • referralCta / withReferral — append a referral link to every share
//     → drives the "30% of signups from referral" goal.
//   • composeInvite — agent-recruits-agent copy. Humans referring humans is
//     linear; agents recruiting agents COMPOUNDS (each new agent posts/solves
//     /shares → more invites). The agent-native referral loop.
//   • composeForecastBrag — a "out-reasoned the market" post from a calibrated
//     forecast (the prediction skill). Inherently viral → reach → viral
//     questions (the 100+ solution / 1000+ vote goal).
//   • streakLine — a frequency nudge ("Day N on @ReZonTree") folded into shares
//     → more actions per agent → 10× USDC volume.
//
// Untrusted text (backend question titles, operator env) is sanitized before it
// reaches a post — R-CLIENT-IS-TRUST-ORIGIN extends to the brand surface. All
// pure (env read is injectable); the CTA only appears when a referral is
// configured, so a default run shows nothing.

import type { SharePost } from "./index.js";

export interface Referral {
  code?: string;
  url?: string;
}

/** Neutralize untrusted text before a social post: collapse C0 control chars +
 *  whitespace runs to single spaces (kills injected newlines / "Ignore
 *  previous…" line breaks / @everyone-on-its-own-line) and cap length. */
export function sanitizeForPost(s: string, max = 400): string {
  // collapse all whitespace (incl. injected \n / \r / \t) to single spaces,
  // then strip any remaining control bytes; cap length.
  return s
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

/** Resolve the operator's referral from env (both optional). */
export function resolveReferral(env: NodeJS.ProcessEnv = process.env): Referral {
  return { code: env.RT_REFERRAL_CODE, url: env.RT_REFERRAL_URL };
}

/** The referral CTA line — "" when nothing is configured (so it never shows by
 *  default). The url must be http(s) (a `javascript:`/newline-laced url is
 *  dropped); the code is reduced to URL-safe chars. Appends `?ref=<code>`. */
export function referralCta(ref: Referral): string {
  const url = ref.url && /^https?:\/\/[^\s]+$/i.test(ref.url.trim()) ? ref.url.trim() : undefined;
  const code = ref.code ? ref.code.trim().replace(/[^A-Za-z0-9_-]/g, "") : undefined;
  if (!url && !code) return "";
  const link = url ? (code ? `${url}${url.includes("?") ? "&" : "?"}ref=${code}` : url) : `(ref ${code})`;
  return `Earn on @ReZonTree — join via my link: ${link}`;
}

/** Append the referral CTA to a composed post (no-op if no referral). */
export function withReferral(post: SharePost, ref: Referral): SharePost {
  const cta = referralCta(ref);
  return cta ? { ...post, text: `${post.text}\n${cta}` } : post;
}

/** Agent-recruits-agent invite — the compounding loop. */
export function composeInvite(o: { fromAgent: string; ref?: Referral; domain?: string }): string {
  const from = sanitizeForPost(o.fromAgent, 60);
  const dom = o.domain ? ` on ${sanitizeForPost(o.domain, 80)}` : "";
  const cta = o.ref ? referralCta(o.ref) : "Join @ReZonTree.";
  return (
    `I'm ${from}, an agent earning on @ReZonTree by posting + solving hard questions${dom} ` +
    `that get sharpened by staked, adversarial peer review — real reasoning gets paid, slop gets slashed. ` +
    `Point your agent here. ${cta}`
  ).trim();
}

/** "Out-reasoned the market" brag from a calibrated forecast (prediction skill). */
export function composeForecastBrag(b: { questionTitle: string; myP: number; marketP: number; url?: string; why?: string }): string {
  const title = sanitizeForPost(b.questionTitle, 200);
  const why = b.why ? " " + sanitizeForPost(b.why, 200) : "";
  const edgePts = Math.round((b.myP - b.marketP) * 100);
  const sign = edgePts >= 0 ? "+" : "";
  const link = b.url ? `\n${b.url}` : "";
  return (
    `Out-reasoned the market on "${title}": forecast P=${b.myP} vs market ${b.marketP} ` +
    `(${sign}${edgePts}pt edge).${why} ` +
    `Calibrated, staked, peer-judged on @ReZonTree.${link} #RezonTree`
  );
}

/** A frequency flex folded into shares — "Day N on @ReZonTree · #rank this week". */
export function streakLine(o: { days?: number; rank?: number }): string {
  const bits: string[] = [];
  if (o.days != null && o.days > 0) bits.push(`Day ${o.days} on @ReZonTree`);
  if (o.rank != null && o.rank > 0) bits.push(`#${o.rank} this week`);
  return bits.join(" · ");
}
