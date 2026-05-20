// submit-quadphase.ts — Quadphase v2 submit composer.
//
// One function dispatches to the right witness builder + envelope
// builder + signer + POST. Replaces the v1
// {sponsor,cosponsor,commit,vote}-intent.ts builders with a unified
// flow:
//
//   preflight → witness → envelope (with witness.contentHash) → sign
//   → POST /v1/quadphase/submit
//
// R-CLIENT-IS-TRUST-ORIGIN: envelopeTemplate from preflight is the
// canonical shape; the client patches contentHash + Funds (per-agent
// amounts) and signs.
//
// For Vote, the voteSaltToken from preflight is echoed in the POST
// body as a sibling of envelope/witness/signature — NOT mixed into
// the witness (the witness is hashed into contentHash; mixing the HMAC
// token in there would defeat the binding design).

import type { Address, Hex, WalletClient } from "viem";

import {
  ActionTag,
  buildEnvelopeForSigning,
  type Envelope,
  type Funds,
} from "./envelope.js";
import { buildSponsorWitness, type SponsorWitness } from "./sponsor-witness.js";
import {
  buildCosponsorWitness,
  type CosponsorWitness,
} from "./cosponsor-witness.js";
import { buildCommitWitness, type CommitWitness } from "./commit-witness.js";
import { buildVoteWitness, type VoteWitness } from "./vote-witness.js";
import { buildSettleWitness, type SettleWitness } from "./settle-witness.js";
import { buildClaimWitness, type ClaimWitness } from "./claim-witness.js";
import { buildRefundWitness, type RefundWitness } from "./refund-witness.js";
import { buildAbandonWitness, type AbandonWitness } from "./abandon-witness.js";

export type Witness =
  | SponsorWitness
  | CosponsorWitness
  | CommitWitness
  | VoteWitness
  | SettleWitness
  | ClaimWitness
  | RefundWitness
  | AbandonWitness;

export interface QuadphaseSubmitParams {
  baseUrl: string;
  bearerToken: string;
  signer: Address;
  qid: Hex;
  nonce: bigint;
  expiresAt: bigint;
  funds: Funds;
  witness: { actionTag: number; contentHash: Hex; payload: Witness };
  chainId: number | bigint;
  forgeAddress: Address;
  walletClient: WalletClient;
  /** Vote-only — verbatim from preflight. */
  voteSaltToken?: Hex;
}

export interface QuadphaseSubmitResponse {
  intentHash: Hex;
  status: string;
  [k: string]: unknown;
}

/**
 * Composes envelope + signature + POST in one call. The witness object
 * is built by the caller via the per-action build*Witness helpers; this
 * function takes the result `{witness, contentHash}` and wires it into
 * the envelope, signs the typed data via viem's signTypedData, and
 * POSTs to /v1/quadphase/submit.
 */
export async function submitQuadphase(
  p: QuadphaseSubmitParams,
): Promise<QuadphaseSubmitResponse> {
  const envelope: Envelope = {
    signer: p.signer,
    qid: p.qid,
    action: p.witness.actionTag as ActionTag,
    nonce: p.nonce,
    expiresAt: p.expiresAt,
    contentHash: p.witness.contentHash,
    funds: p.funds,
  };

  const typedData = buildEnvelopeForSigning({
    envelope,
    chainId: p.chainId,
    forgeAddress: p.forgeAddress,
  });

  if (!p.walletClient.account) {
    throw new Error(
      "submitQuadphase: walletClient.account is required to sign the envelope",
    );
  }

  const signature = await p.walletClient.signTypedData({
    account: p.walletClient.account,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message as never,
  });

  const body: Record<string, unknown> = {
    envelope: serializeEnvelope(envelope),
    witness: p.witness.payload,
    signature,
  };
  if (envelope.action === ActionTag.Vote) {
    if (!p.voteSaltToken) {
      throw new Error(
        "submitQuadphase: voteSaltToken is required for action=Vote (echoed verbatim from preflight)",
      );
    }
    body.voteSaltToken = p.voteSaltToken;
  }

  const res = await fetch(`${p.baseUrl}/v1/quadphase/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.bearerToken}`,
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `submitQuadphase: HTTP ${res.status} ${res.statusText}: ${text}`,
    );
  }
  return JSON.parse(text) as QuadphaseSubmitResponse;
}

/**
 * Re-exports the per-action builders for ergonomic single-import use.
 */
export {
  buildSponsorWitness,
  buildCosponsorWitness,
  buildCommitWitness,
  buildVoteWitness,
  buildSettleWitness,
  buildClaimWitness,
  buildRefundWitness,
  buildAbandonWitness,
};

// ─────────────────────────────────────────────────────────────────────
// Wire serializers — bigint fields ship as decimal strings per the
// R-WIRE-ABSOLUTE-UNIX + Go signer's JSON marshaller convention.
// ─────────────────────────────────────────────────────────────────────

function serializeEnvelope(e: Envelope): Record<string, unknown> {
  return {
    signer: e.signer,
    questionId: e.qid,
    action: e.action,
    nonce: e.nonce.toString(),
    expiresAt: Number(e.expiresAt), // int64 on the wire per Go marshaller
    contentHash: e.contentHash,
    funds: {
      token: e.funds.token,
      poolIn: e.funds.poolIn.toString(),
      poolOut: e.funds.poolOut.toString(),
      feeAmount: e.funds.feeAmount.toString(),
      feeShareBps: e.funds.feeShareBps,
      feeShares: e.funds.feeShares,
      stakeAmount: e.funds.stakeAmount.toString(),
      stakeOp: e.funds.stakeOp,
    },
  };
}
