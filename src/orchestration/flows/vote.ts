// flows/vote.ts — judge solutions + cast conviction (deterministic flow).
//
// Extracted verbatim from organic-swarm.ts actVote; module globals → ctx.*.
// The vote-specific pure helpers (normalizeCriteria / convictionToBps /
// evenSplitBps) move here with it — they are used nowhere else. Behavior is
// byte-identical. The sharp decider (sanitize → matrix → credibility) is the
// deterministic judgment; the agent's own fact-check is the non-deterministic
// step the doctrine reserves for it.

import type { Address, Hex } from "viem";

import { ensureUsdcAllowance, runVoteFlow } from "../../forge/quadphase-flow.js";
import { awaitReceipt } from "../../forge/quadphase-broadcast.js";
import type { VotePreflight } from "../../intents/preflight-types.js";
import { decideVote } from "../../voting/decide.js";
import { scanSolutionInjection } from "../../voting/injection.js";
import type { VoteCriterion } from "../../voting/matrix.js";
import type { Flow, FlowCtx, Agent, VoteTarget } from "../types.js";

/** Map question success-criteria to matrix VoteCriterion[]; equal weights when
 *  the projection carries none. */
export function normalizeCriteria(raw: { id: string; name: string; weight?: number }[]): VoteCriterion[] {
  if (raw.length === 0) return [];
  const weighted = raw.some((c) => Number(c.weight ?? 0) > 0);
  const equal = 100 / raw.length;
  return raw.map((c) => ({ id: c.id, name: c.name, weight: weighted ? Number(c.weight ?? 0) : equal }));
}

/** conviction points (Σ=100) → basis points (Σ=10000); last takes the remainder. */
export function convictionToBps(allocs: { intentHash: string; conviction: number }[]): { solutionId: Hex; basisPoints: number }[] {
  let assigned = 0;
  return allocs.map((al, i) => {
    const bps = i === allocs.length - 1 ? 10000 - assigned : al.conviction * 100;
    assigned += bps;
    return { solutionId: al.intentHash as Hex, basisPoints: bps };
  });
}

/** even split across ids → Σ=10000 bps; last takes the remainder. */
export function evenSplitBps(ids: Hex[]): { solutionId: Hex; basisPoints: number }[] {
  let assigned = 0;
  return ids.map((id, i) => {
    const bps = i === ids.length - 1 ? 10000 - assigned : Math.floor(10000 / ids.length);
    assigned += bps;
    return { solutionId: id, basisPoints: bps };
  });
}

export const voteFlow: Flow<VoteTarget> = {
  name: "vote",
  summary: "Judge solutions against the criteria and allocate conviction to the most-probable winner.",
  context: ["voter_workflow"],
  async run(a: Agent, { q, sols }: VoteTarget, ctx: FlowCtx): Promise<void> {
    const self = a.address.toLowerCase();
    const votable = sols.filter((s) => s.author !== self);
    if (votable.length === 0) throw new Error("no votable solutions (all self-authored)");

    // Sharp decider: sanitize injection → structural matrix → credibility → vote
    // the most-probable winner(s). Falls back to an even split only when the
    // decider can't separate candidates (claims absent from the projection),
    // which keeps the vote path live on testnet without casting a blind vote on
    // an injection-flagged solution.
    const detail = await ctx.call<{ successCriteria?: { id: string; name: string; weight?: number }[] }>("GET", `/v1/questions/${q.id}`, undefined, a.token);
    const criteria = normalizeCriteria(detail.body?.successCriteria ?? []);
    const decision = decideVote(criteria, votable);
    let allocations: { solutionId: Hex; basisPoints: number }[];
    if (decision.allocations.length > 0) {
      allocations = convictionToBps(decision.allocations);
      ctx.log(a.name, `JUDGE ${q.id} ${decision.rationale}`);
    } else {
      // No decisive winner (e.g. claims absent from the projection). Even-split
      // as a liveness fallback — but NEVER over an injection-flagged solution, or
      // an attacker's directive would capture the conviction. If nothing clean
      // remains, cast nothing rather than vote blind.
      const clean = votable.filter((s) => !scanSolutionInjection(s).detected);
      if (clean.length === 0) {
        ctx.log(a.name, `JUDGE ${q.id} all candidates flagged for manipulation — no vote cast`);
        return;
      }
      allocations = evenSplitBps(clean.slice(0, 3).map((s) => s.intentHash as Hex));
      ctx.log(a.name, `JUDGE ${q.id} no decisive winner — even split across ${allocations.length} clean sol(s)`);
    }

    const pre = await ctx.preflight<VotePreflight>(q.id, "vote", "voter", a.address, a.token);
    if (!pre.voteSalt || !pre.voteSaltToken || !pre.voteSaltExpiresAt) throw new Error("vote preflight missing voteSalt/voteSaltExpiresAt");
    const stake = BigInt(pre.stakeAmount);
    const wc = ctx.makeWc(a.wallet);
    await ensureUsdcAllowance(wc, ctx.publicClient as any, { usdc: ctx.cfg.usdc, forge: ctx.cfg.forge, owner: a.address, required: stake });
    const feeShares = (pre.feeShares && pre.feeShares.length > 0)
      ? pre.feeShares.map((s: any) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
      : [{ recipient: pre.platformFeeRecipient as Address, basisPoints: 10000 }];
    const r = await runVoteFlow({
      baseUrl: ctx.cfg.backend, bearerToken: a.token, signer: a.address, questionId: q.id, qid: pre.qid as Hex,
      nonce: BigInt(pre.nonce ?? "0"), expiresAt: BigInt(pre.voteSaltExpiresAt!),
      forgeAddress: ctx.cfg.forge, chainId: pre.chainId ?? ctx.cfg.chainId,
      expectedIntentHash: undefined as unknown as Hex, allocations,
      voteSalt: pre.voteSalt as Hex, voteSaltToken: pre.voteSaltToken as Hex,
      token: pre.token.contractAddress as Address, stakeAmount: stake,
      feeShareBps: pre.feeShareBps ?? 0, feeShares,
      walletClient: wc, privateKey: a.wallet.privateKey as Hex,
    });
    await awaitReceipt(ctx.publicClient as any, r.txHash!);
    a.voted.add(q.id);
    ctx.log(a.name, `VOTE  ${q.id} across ${allocations.length} sol(s) stake=${ctx.cfg.sponsorAmount} USDC`);
  },
};
