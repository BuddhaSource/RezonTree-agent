// quadphase-broadcast.test.ts — golden + round-trip fence for the witness
// ABI encoders that build chain calldata. These functions are fund-critical:
// a wrong field order or ABI type produces calldata the contract decodes into
// the wrong struct → a reverted or, worse, a silently-misdirected tx. They had
// ZERO coverage; this locks their exact output (golden) and proves the bytes
// decode back to the input struct (round-trip). A deliberate encoder change
// must update the golden hex here, forcing review.
//
// Companion to the EIP-712 fences in src/intents/ (which lock the signed-hash
// path). Together they fence both halves of every chain-bound action: what
// gets SIGNED (intents) and what gets BROADCAST (these).

import { decodeAbiParameters, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

import { ActionTag } from "../intents/envelope.js";
import type { AbandonWitness } from "../intents/abandon-witness.js";
import type { RefundWitness } from "../intents/refund-witness.js";
import type { SettleWitness } from "../intents/settle-witness.js";
import type { SponsorWitness } from "../intents/sponsor-witness.js";
import {
  encodeAbandonWitnessBytes,
  encodeRefundWitnessBytes,
  encodeSettleWitnessBytes,
  encodeSponsorWitnessBytes,
} from "./quadphase-broadcast.js";

// ── fixtures (kept byte-stable; changing a value changes the golden hex) ──
const SPONSOR: SponsorWitness = {
  actionTag: ActionTag.Sponsor,
  title: "T",
  body: "B",
  criteria: "C",
  tags: ["a", "b"],
  oracle: "0x1111111111111111111111111111111111111111",
  sponsorshipFloor: 1_000_000n,
  commitFee: 0n,
  voteFee: 1_000_000n,
  stakeFloor: 1_000_000n,
  stakeBasisPoints: 1000,
  fundingDeadline: 1_782_909_810n,
  noSolutionGracePeriod: 86_400n,
};
const ABANDON: AbandonWitness = {
  actionTag: ActionTag.Abandon,
  expectedStatus: 1,
  reason: `0x${"ab".repeat(32)}`,
};
const REFUND: RefundWitness = {
  actionTag: ActionTag.Refund,
  sourceIntentHash: `0x${"cd".repeat(32)}`,
  expectedAmount: 1_000_000n,
  expectedStatus: 3,
};
const SETTLE: SettleWitness = {
  actionTag: ActionTag.Settle,
  merkleRoot: `0x${"ef".repeat(32)}`,
  totalClaimable: 2_700_000n,
  feeTotal: 300_000n,
  slashes: [{ intentHash: `0x${"12".repeat(32)}`, amount: 1_000_000n, role: 2 }],
  leafCount: 3n,
  slashEntryOffset: 0n,
  totalSlashEntries: 1n,
  feeDistributions: [
    { recipient: "0x2222222222222222222222222222222222222222", amount: 300_000n },
  ],
};

// ── golden bytes (captured from the encoders; lock against future drift) ──
const GOLDEN = {
  sponsor:
    "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000260000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000006a450b7200000000000000000000000000000000000000000000000000000000000151800000000000000000000000000000000000000000000000000000000000000001540000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000143000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000001610000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000016200000000000000000000000000000000000000000000000000000000000000",
  abandon:
    "0x00000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000001abababababababababababababababababababababababababababababababab",
  refund:
    "0x0000000000000000000000000000000000000000000000000000000000000006cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000003",
  settle:
    "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef00000000000000000000000000000000000000000000000000000000002932e000000000000000000000000000000000000000000000000000000000000493e0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000001121212121212121212121212121212121212121212121212121212121212121200000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000493e0",
} as const;

describe("witness-bytes encoders — golden (locks exact calldata)", () => {
  it("encodeSponsorWitnessBytes", () => {
    expect(encodeSponsorWitnessBytes(SPONSOR)).toBe(GOLDEN.sponsor);
  });
  it("encodeAbandonWitnessBytes", () => {
    expect(encodeAbandonWitnessBytes(ABANDON)).toBe(GOLDEN.abandon);
  });
  it("encodeRefundWitnessBytes", () => {
    expect(encodeRefundWitnessBytes(REFUND)).toBe(GOLDEN.refund);
  });
  it("encodeSettleWitnessBytes", () => {
    expect(encodeSettleWitnessBytes(SETTLE)).toBe(GOLDEN.settle);
  });
});

describe("witness-bytes encoders — round-trip (bytes decode to the struct)", () => {
  it("sponsor round-trips field-for-field", () => {
    const [d] = decodeAbiParameters(
      parseAbiParameters(
        "(uint8 actionTag, string title, string body, string criteria, string[] tags, address oracle, uint256 sponsorshipFloor, uint256 commitFee, uint256 voteFee, uint256 stakeFloor, uint16 stakeBasisPoints, uint256 fundingDeadline, uint256 noSolutionGracePeriod)",
      ),
      encodeSponsorWitnessBytes(SPONSOR),
    ) as unknown as [Record<string, unknown>];
    expect(d.title).toBe("T");
    expect(d.tags).toEqual(["a", "b"]);
    expect(d.oracle).toBe(SPONSOR.oracle);
    expect(d.voteFee).toBe(1_000_000n);
    expect(d.stakeBasisPoints).toBe(1000);
    expect(d.fundingDeadline).toBe(1_782_909_810n);
  });

  it("settle round-trips the nested slash + feeDistribution arrays", () => {
    const [d] = decodeAbiParameters(
      parseAbiParameters(
        "(uint8 actionTag, bytes32 merkleRoot, uint256 totalClaimable, uint256 feeTotal, (bytes32 intentHash, uint256 amount, uint8 role)[] slashes, uint256 leafCount, uint256 slashEntryOffset, uint256 totalSlashEntries, (address recipient, uint256 amount)[] feeDistributions)",
      ),
      encodeSettleWitnessBytes(SETTLE),
    ) as unknown as [{ slashes: { amount: bigint; role: number }[]; feeDistributions: { recipient: string; amount: bigint }[]; totalClaimable: bigint; feeTotal: bigint }];
    expect(d.totalClaimable).toBe(2_700_000n);
    expect(d.feeTotal).toBe(300_000n);
    expect(d.slashes[0].amount).toBe(1_000_000n);
    expect(d.slashes[0].role).toBe(2);
    expect(d.feeDistributions[0].recipient).toBe(SETTLE.feeDistributions[0].recipient);
    expect(d.feeDistributions[0].amount).toBe(300_000n);
  });

  // abandon + refund round-trips: golden alone can't catch a same-byte-width
  // type regression (e.g. a uint8 widened to uint16 keeps the 32-byte slot),
  // so decode-and-compare guards the field types too.
  it("abandon round-trips field-for-field", () => {
    const [d] = decodeAbiParameters(
      parseAbiParameters("(uint8 actionTag, uint8 expectedStatus, bytes32 reason)"),
      encodeAbandonWitnessBytes(ABANDON),
    ) as unknown as [{ actionTag: number; expectedStatus: number; reason: string }];
    expect(d.actionTag).toBe(ActionTag.Abandon);
    expect(d.expectedStatus).toBe(1);
    expect(d.reason).toBe(ABANDON.reason);
  });

  it("refund round-trips field-for-field", () => {
    const [d] = decodeAbiParameters(
      parseAbiParameters(
        "(uint8 actionTag, bytes32 sourceIntentHash, uint256 expectedAmount, uint8 expectedStatus)",
      ),
      encodeRefundWitnessBytes(REFUND),
    ) as unknown as [{ actionTag: number; sourceIntentHash: string; expectedAmount: bigint; expectedStatus: number }];
    expect(d.actionTag).toBe(ActionTag.Refund);
    expect(d.sourceIntentHash).toBe(REFUND.sourceIntentHash);
    expect(d.expectedAmount).toBe(1_000_000n);
    expect(d.expectedStatus).toBe(3);
  });
});
