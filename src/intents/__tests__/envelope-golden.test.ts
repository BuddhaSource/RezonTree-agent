// envelope-golden.test.ts — SDK-side mirror of the backend's
// internal/signer/envelope_golden_test.go.
//
// Loads the shared golden fixture at testdata/envelope-vectors.json
// (kept byte-identical with the backend copy at
// internal/signer/testdata/envelope-vectors.json — fenced on the Go
// side by TestQuadphaseGoldenVectors_SDKMirrorParity) and recomputes:
//
//   - witness contentHash via the SDK builders (build*Witness)
//   - envelope intentHash via hashEnvelopeStruct
//
// then asserts byte-equality with the fixture's expectedContentHash +
// expectedIntentHash. Drift between the Go signer / Solidity contract /
// SDK reproduces as a vector mismatch here.
//
// PA5 audit follow-up: B7's cross-stack typehash drift fence is the
// Go side; this is its TS-side counterpart. Together they close the
// loop: same JSON bytes, same hashes.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";

import {
  ActionTag,
  hashEnvelopeStruct,
  StakeOp,
  type Envelope,
  type FeeShare,
  type Funds,
} from "../envelope.js";
import { buildSponsorWitness } from "../sponsor-witness.js";
import { buildCosponsorWitness } from "../cosponsor-witness.js";
import { buildCommitWitness } from "../commit-witness.js";
import { buildVoteWitness } from "../vote-witness.js";
import { buildSettleWitness, type FeeDistribution, type SlashEntry } from "../settle-witness.js";
import { buildClaimWitness } from "../claim-witness.js";
import { buildRefundWitness } from "../refund-witness.js";
import { buildAbandonWitness } from "../abandon-witness.js";

// Fixture row shape (camelCase JSON keys mirror the backend's struct
// tags — see internal/signer/envelope_golden_test.go envelopeFixture).
interface FixtureFunds {
  token: string;
  poolIn: number | string;
  poolOut: number | string;
  feeAmount: number | string;
  feeShareBps: number;
  feeShares: { recipient: string; basisPoints: number }[];
  stakeAmount: number | string;
  stakeOp: number;
}

interface FixtureEnvelope {
  signer: string;
  questionId: string;
  action: number;
  nonce: number | string;
  expiresAt: number | string;
  contentHash: string;
  funds: FixtureFunds;
}

interface EnvelopeFixture {
  name: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  envelope: FixtureEnvelope;
  witness: Record<string, unknown>;
  expectedContentHash: string;
  expectedIntentHash: string;
}

function toBigInt(v: number | string): bigint {
  return typeof v === "string" ? BigInt(v) : BigInt(Math.trunc(v));
}

function toFunds(f: FixtureFunds): Funds {
  return {
    token: f.token as Address,
    poolIn: toBigInt(f.poolIn),
    poolOut: toBigInt(f.poolOut),
    feeAmount: toBigInt(f.feeAmount),
    feeShareBps: f.feeShareBps,
    feeShares: f.feeShares.map(
      (s): FeeShare => ({
        recipient: s.recipient as Address,
        basisPoints: s.basisPoints,
      }),
    ),
    stakeAmount: toBigInt(f.stakeAmount),
    stakeOp: f.stakeOp as StakeOp,
  };
}

function toEnvelope(e: FixtureEnvelope): Envelope {
  return {
    signer: e.signer as Address,
    qid: e.questionId as Hex,
    action: e.action as ActionTag,
    nonce: toBigInt(e.nonce),
    expiresAt: toBigInt(e.expiresAt),
    contentHash: e.contentHash as Hex,
    funds: toFunds(e.funds),
  };
}

// recomputeContentHash dispatches to the per-action witness builder
// and returns the contentHash the builder produced. Throws if the
// JSON shape can't be coerced to the witness type — defensive against
// fixture drift after a schema change.
function recomputeContentHash(action: ActionTag, w: Record<string, unknown>): Hex {
  switch (action) {
    case ActionTag.Sponsor: {
      const { contentHash } = buildSponsorWitness({
        title: w.title as string,
        body: w.body as string,
        criteria: w.criteria as string,
        tags: w.tags as string[],
        oracle: w.oracle as Address,
        sponsorshipFloor: toBigInt(w.sponsorshipFloor as number | string),
        commitFee: toBigInt(w.commitFee as number | string),
        voteFee: toBigInt(w.voteFee as number | string),
        stakeFloor: toBigInt(w.stakeFloor as number | string),
        stakeBasisPoints: w.stakeBasisPoints as number,
        fundingDeadline: toBigInt(w.fundingDeadline as number | string),
        noSolutionGracePeriod: toBigInt(w.noSolutionGracePeriod as number | string),
      });
      return contentHash;
    }
    case ActionTag.Cosponsor: {
      const { contentHash } = buildCosponsorWitness({
        amount: toBigInt(w.amount as number | string),
      });
      return contentHash;
    }
    case ActionTag.Commit: {
      const { contentHash } = buildCommitWitness({
        solutionBody: w.solutionBody as string,
        references: w.references as string[],
      });
      return contentHash;
    }
    case ActionTag.Vote: {
      const allocations = (w.allocations as { solutionId: string; basisPoints: number }[]).map(
        (a) => ({ solutionId: a.solutionId as Hex, basisPoints: a.basisPoints }),
      );
      const { contentHash } = buildVoteWitness({
        allocations,
        salt: w.salt as Hex,
      });
      return contentHash;
    }
    case ActionTag.Settle: {
      const slashes = ((w.slashes as { intentHash: string; amount: number | string; role: number }[]) ?? []).map(
        (s): SlashEntry => ({
          intentHash: s.intentHash as Hex,
          amount: toBigInt(s.amount),
          role: s.role,
        }),
      );
      const feeDistributions = ((w.feeDistributions as { recipient: string; amount: number | string }[]) ?? []).map(
        (f): FeeDistribution => ({
          recipient: f.recipient as Hex,
          amount: toBigInt(f.amount),
        }),
      );
      const { contentHash } = buildSettleWitness({
        merkleRoot: w.merkleRoot as Hex,
        totalClaimable: toBigInt(w.totalClaimable as number | string),
        feeTotal: toBigInt(w.feeTotal as number | string),
        slashes,
        leafCount: toBigInt(w.leafCount as number | string),
        slashEntryOffset: toBigInt(w.slashEntryOffset as number | string),
        totalSlashEntries: toBigInt(w.totalSlashEntries as number | string),
        feeDistributions,
      });
      return contentHash;
    }
    case ActionTag.Claim: {
      const proof = ((w.proof as string[]) ?? []).map((p) => p as Hex);
      const { contentHash } = buildClaimWitness({
        proof,
        leafIndex: toBigInt(w.leafIndex as number | string),
        leafAmount: toBigInt(w.leafAmount as number | string),
        role: w.role as number,
        expectedStatus: w.expectedStatus as number,
      });
      return contentHash;
    }
    case ActionTag.Refund: {
      const { contentHash } = buildRefundWitness({
        sourceIntentHash: w.sourceIntentHash as Hex,
        expectedAmount: toBigInt(w.expectedAmount as number | string),
        expectedStatus: w.expectedStatus as number,
      });
      return contentHash;
    }
    case ActionTag.Abandon: {
      const { contentHash } = buildAbandonWitness({
        expectedStatus: w.expectedStatus as number,
        reason: w.reason as Hex,
      });
      return contentHash;
    }
    default:
      throw new Error(`unknown action ordinal ${action}`);
  }
}

// Fixture file lives at <repo>/testdata/envelope-vectors.json.
const FIXTURE_PATH = join(__dirname, "..", "..", "..", "testdata", "envelope-vectors.json");

describe("envelope golden vectors", () => {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const fixtures = JSON.parse(raw) as EnvelopeFixture[];

  it("loads at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fx of fixtures) {
    it(`${fx.name}: contentHash matches backend`, () => {
      const envelope = toEnvelope(fx.envelope);
      const recomputedContent = recomputeContentHash(envelope.action, fx.witness);
      expect(recomputedContent.toLowerCase()).toBe(fx.expectedContentHash.toLowerCase());
      // Envelope's own contentHash field must equal what the builder
      // produced — otherwise the intentHash is over a different payload.
      expect(envelope.contentHash.toLowerCase()).toBe(recomputedContent.toLowerCase());
    });

    it(`${fx.name}: intentHash matches backend`, () => {
      const envelope = toEnvelope(fx.envelope);
      const intentHash = hashEnvelopeStruct(envelope);
      expect(intentHash.toLowerCase()).toBe(fx.expectedIntentHash.toLowerCase());
    });
  }
});
