// fee-share.ts — shared FeeShare type + chain-valid default policy
// for sponsor / cosponsor / commit / vote intents (RezonForge v2.5).
//
// Why a default exists at all: RezonForge.sol's
// _validateFeeSharePolicy rejects empty FeeShares unconditionally
// (loop 0129). Even when a contributor wants "all to pool" semantics,
// the chain insists on a token recipient. 1 bps + a single self-
// recipient at 10000 bps is the smallest chain-valid configuration:
// 99.99% of the contribution flows through normal pool accounting;
// 0.01% accrues to self via pendingShares. Override via the splitter
// UI for non-trivial reservations.
//
// Mirrors RezonTree-UI/lib/intents/fee-share-defaults.ts byte-for-byte.

export interface FeeShare {
  recipient: `0x${string}`;
  basisPoints: bigint;
}

export interface FeeSharePolicy {
  bps: bigint;
  shares: FeeShare[];
}

/**
 * Smallest chain-valid FeeSharePolicy: 1 bps reserved, 100% routed
 * to `selfAddress`. Use this as the default whenever a caller hasn't
 * configured an explicit splitter — RezonForge rejects empty share
 * arrays even when feeShareBps is zero, so we MUST emit at least one
 * recipient.
 */
export function defaultFeeSharePolicy(
  selfAddress: `0x${string}`,
): FeeSharePolicy {
  return {
    bps: BigInt(1),
    shares: [
      {
        recipient: selfAddress,
        basisPoints: BigInt(10000),
      },
    ],
  };
}

// 15-min TTL on signed intents. Mirrors backend's MaxPermitTTL
// ceiling (loop 0031) — anything longer is rejected by the
// off-chain intake layer; on-chain the Forge re-checks against
// block.timestamp via _checkExpiry.
export const INTENT_TTL_SECONDS = 15 * 60;
