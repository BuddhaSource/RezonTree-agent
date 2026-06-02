// flows/solve.ts — submit a solution to a question (deterministic flow).
//
// Extracted verbatim from organic-swarm.ts actSolve; module globals → ctx.*.
// Behavior is byte-identical. The templated reasoningTree/claims here are the
// testnet harness's stand-in content; an LLM-driven agent authors the body from
// the flow's declared `context` instead.

import type { Address, Hex } from "viem";

import { ensureUsdcAllowance, runCommitFlow } from "../../forge/quadphase-flow.js";
import { awaitReceipt } from "../../forge/quadphase-broadcast.js";
import { canonicalStringify } from "../../intents/commit-intent.js";
import type { CommitPreflight } from "../../intents/preflight-types.js";
import { makeSolutionBody } from "../../testnet/solution-body.js";
import type { Flow, FlowCtx, Agent, OpenQ } from "../types.js";

export const solveFlow: Flow<OpenQ> = {
  name: "solve",
  summary: "Submit a falsifiable, evidence-backed solution to an open question — stake to earn the pool.",
  context: ["solve_solution_scaffold"],
  async run(a: Agent, q: OpenQ, ctx: FlowCtx): Promise<void> {
    // Claims must reference the question's REAL success-criterion IDs (FK on
    // claims.criterion_id); a bogus id FK-violates → 500. Fetch them.
    const detail = await ctx.call<{ successCriteria?: { id: string; name: string }[] }>("GET", `/v1/questions/${q.id}`, undefined, a.token);
    const criteria = detail.body?.successCriteria ?? [];
    const pre = await ctx.preflight<CommitPreflight>(q.id, "commit", "submitter", a.address, a.token);
    const stake = BigInt(pre.stakeAmount);
    const wc = ctx.makeWc(a.wallet);
    await ensureUsdcAllowance(wc, ctx.publicClient as any, { usdc: ctx.cfg.usdc, forge: ctx.cfg.forge, owner: a.address, required: stake });
    // Backend requires 6-25 reasoningTree nodes, each {because, therefore, confidence}.
    const payload = {
      body: makeSolutionBody(a.name, q.id),
      reasoningTree: [
        { because: `${a.name} parsed the question's success criteria`, therefore: "each criterion gets a falsifiable claim", confidence: 0.9 },
        { because: "the strongest answer wins by voter conviction", therefore: "the argument is structured for adversarial review", confidence: 0.8 },
        { because: "the realized-outcome fee model skims once at settlement", therefore: "no per-action fee distorts the incentive to submit quality", confidence: 0.85 },
        { because: "losers forfeit their full stake into the pool", therefore: "low-effort submissions are priced out (anti-slop)", confidence: 0.8 },
        { because: "winners recover stake plus a conviction-weighted pool share", therefore: "effort is rewarded proportionally to peer-judged quality", confidence: 0.75 },
        { because: "the claim is grounded in cited, checkable evidence", therefore: "a skeptical voter can verify rather than trust", confidence: 0.7 },
      ],
      claims: criteria.map((c) => ({ criterionId: c.id, value: true, argument: `${a.name}: evidence-backed claim against ${c.name}`, falsifiableBy: "audit failure" })),
    };
    const feeShares = (pre.feeShares && pre.feeShares.length > 0)
      ? pre.feeShares.map((s: any) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints }))
      : [{ recipient: pre.platformFeeRecipient as Address, basisPoints: 10000 }];
    const r = await runCommitFlow({
      baseUrl: ctx.cfg.backend, bearerToken: a.token, signer: a.address, questionId: q.id, qid: pre.qid as Hex,
      nonce: BigInt(pre.nonce ?? "0"),
      expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
      forgeAddress: ctx.cfg.forge, chainId: pre.chainId ?? ctx.cfg.chainId,
      solutionBody: canonicalStringify(payload), references: [],
      token: pre.token.contractAddress as Address, stakeAmount: stake,
      feeShareBps: pre.feeShareBps ?? 0, feeShares,
      walletClient: wc, privateKey: a.wallet.privateKey as Hex,
    });
    await awaitReceipt(ctx.publicClient as any, r.txHash!);
    a.solved.add(q.id);
    ctx.log(a.name, `SOLVE ${q.id} stake=${ctx.cfg.sponsorAmount} USDC "${q.title.slice(0, 32)}"`);
    await ctx.share?.({ action: "solve", agent: a.name, questionId: q.id, questionTitle: q.title });
  },
};
