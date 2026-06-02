// flows/ask.ts — author + sponsor a question (deterministic flow).
//
// Extracted verbatim from organic-swarm.ts actAsk; only module globals became
// ctx.* (FlowCtx). Behavior is byte-identical.

import type { Address, Hex } from "viem";

import { ensureUsdcAllowance, runSponsorFlow } from "../../forge/quadphase-flow.js";
import { awaitReceipt } from "../../forge/quadphase-broadcast.js";
import { parseAmountToWei } from "../../intents/amounts.js";
import type { FundPreflight } from "../../intents/preflight-types.js";
import type { Flow, FlowCtx, Agent } from "../types.js";

const pickTopic = (topics: { title: string; framing: string }[]) =>
  topics[Math.floor(Math.random() * topics.length)];

/** Pad the framing to the backend's ≥1000-char description floor. */
function makeDescription(framing: string, tag: string): string {
  let d = framing;
  while (d.length < 1050) {
    d += `\n\nSubmissions are scored against the success criteria below; the strongest answer wins by voter conviction. Address the stated model, cite evidence where it exists, and identify the gaps current approaches cannot close. (${tag})`;
  }
  return d;
}

export const askFlow: Flow = {
  name: "ask",
  summary: "Post + sponsor a new question — crowdsource a hard problem you want solved.",
  context: ["post_question_scaffold", "weight_guidance"],
  async run(a: Agent, _target: void, ctx: FlowCtx): Promise<void> {
    const topic = pickTopic(ctx.cfg.topics);
    const tag = `${a.name}-${Date.now().toString(36)}`;
    const qResp = await ctx.call<{ id: string; successCriteria: { id: string; name: string }[] }>("POST", "/v1/questions", {
      title: topic.title,
      description: makeDescription(topic.framing, tag),
      successCriteria: [
        { name: "criterion_one", type: "boolean", target: "true", weight: 40 },
        { name: "criterion_two", type: "boolean", target: "true", weight: 35 },
        { name: "criterion_three", type: "boolean", target: "true", weight: 25 },
      ],
      initialBounty: ctx.cfg.initialBounty,
    }, a.token);
    if (qResp.status !== 201) throw new Error(`create question -> ${qResp.status} ${JSON.stringify(qResp.body).slice(0, 160)}`);
    const questionId = qResp.body.id;
    const qDetail = await ctx.call<{ title: string; description: string }>("GET", `/v1/questions/${questionId}`, undefined, a.token);

    const pre = await ctx.preflight<FundPreflight>(questionId, "sponsor", "sponsor", a.address, a.token);
    const qid = pre.qid as Hex;
    const amount = parseAmountToWei(ctx.cfg.sponsorAmount, pre.token.decimals);
    const wc = ctx.makeWc(a.wallet);
    await ensureUsdcAllowance(wc, ctx.publicClient as any, { usdc: ctx.cfg.usdc, forge: ctx.cfg.forge, owner: a.address, required: amount });
    const r = await runSponsorFlow({
      baseUrl: ctx.cfg.backend, bearerToken: a.token, signer: a.address, questionId, qid,
      nonce: BigInt(pre.nonce ?? "0"),
      expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
      forgeAddress: ctx.cfg.forge, chainId: pre.chainId ?? ctx.cfg.chainId,
      expectedIntentHash: pre.expectedIntentHash as Hex,
      title: qDetail.body?.title ?? topic.title, body: qDetail.body?.description ?? "", criteria: "", tags: [],
      oracle: (pre.oracle as Address),
      sponsorshipFloor: BigInt(pre.sponsorshipFloor ?? pre.recommendedSponsorshipFloor ?? "0"),
      commitFee: BigInt(pre.commitFee ?? "0"), voteFee: BigInt(pre.voteFee ?? "0"),
      stakeFloor: BigInt(pre.stakeFloor ?? "0"), stakeBasisPoints: Number(pre.stakeBasisPoints ?? "0"),
      fundingDeadline: BigInt(pre.recommendedFundingDeadline ?? Math.floor(Date.now() / 1000) + 30 * 86400),
      noSolutionGracePeriod: BigInt(pre.noSolutionGracePeriod ?? "120"),
      token: pre.token.contractAddress as Address, amount, feeAmount: 0n,
      feeShareBps: Number(pre.feeShareBps ?? 0),
      feeShares: [{ recipient: pre.platformFeeRecipient as Address, basisPoints: 10000 }],
      walletClient: wc, privateKey: a.wallet.privateKey as Hex,
    });
    await awaitReceipt(ctx.publicClient as any, r.txHash!);
    a.sponsored.add(questionId);
    ctx.log(a.name, `ASK   "${topic.title.slice(0, 38)}" → ${questionId} (sponsored ${ctx.cfg.sponsorAmount} USDC)`);
  },
};
