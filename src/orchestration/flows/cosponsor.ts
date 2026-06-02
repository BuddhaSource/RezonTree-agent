// flows/cosponsor.ts — add funding to an existing question (deterministic flow).
//
// Extracted verbatim from organic-swarm.ts actCosponsor; module globals → ctx.*.
// Behavior is byte-identical.

import type { Address, Hex } from "viem";

import { ensureUsdcAllowance, runCosponsorFlow } from "../../forge/quadphase-flow.js";
import { awaitReceipt } from "../../forge/quadphase-broadcast.js";
import { parseAmountToWei } from "../../intents/amounts.js";
import type { FundPreflight } from "../../intents/preflight-types.js";
import type { Flow, FlowCtx, Agent, OpenQ } from "../types.js";

export const cosponsorFlow: Flow<OpenQ> = {
  name: "cosponsor",
  summary: "Add funding to an existing question — grow the bounty on a problem worth more attention.",
  context: [],
  async run(a: Agent, q: OpenQ, ctx: FlowCtx): Promise<void> {
    const pre = await ctx.preflight<FundPreflight>(q.id, "cosponsor", "cosponsor", a.address, a.token);
    const amount = parseAmountToWei(ctx.cfg.sponsorAmount, pre.token.decimals);
    const wc = ctx.makeWc(a.wallet);
    await ensureUsdcAllowance(wc, ctx.publicClient as any, { usdc: ctx.cfg.usdc, forge: ctx.cfg.forge, owner: a.address, required: amount });
    const r = await runCosponsorFlow({
      baseUrl: ctx.cfg.backend, bearerToken: a.token, signer: a.address, questionId: q.id, qid: pre.qid as Hex,
      nonce: BigInt(pre.nonce ?? "0"),
      expiresAt: BigInt(pre.recommendedExpiresAt ?? Math.floor(Date.now() / 1000) + 300),
      forgeAddress: ctx.cfg.forge, chainId: pre.chainId ?? ctx.cfg.chainId,
      expectedIntentHash: pre.expectedIntentHash as Hex,
      token: pre.token.contractAddress as Address, amount, feeAmount: 0n,
      // Echo the backend-advertised policy feeShares verbatim (realized-outcome;
      // chain requires non-empty per shape:cosponsor:feeShares-required).
      feeShares: (pre.feeShares ?? []).map((s) => ({ recipient: s.recipient as Address, basisPoints: s.basisPoints })),
      feeShareBps: Number(pre.feeShareBps ?? 0),
      walletClient: wc, privateKey: a.wallet.privateKey as Hex,
    });
    await awaitReceipt(ctx.publicClient as any, r.txHash!);
    a.cosponsored.add(q.id);
    ctx.log(a.name, `COSPO ${q.id} +${ctx.cfg.sponsorAmount} USDC "${q.title.slice(0, 30)}"`);
  },
};
