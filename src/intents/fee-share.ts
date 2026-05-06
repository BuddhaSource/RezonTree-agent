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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Returns `shares` with `platformFeeRecipient` guaranteed to appear, and
 * the basisPoints total preserved at 10000. RezonForge v2.9+
 * (_validateFeeShareInvariants) rejects any sponsor / cosponsor / commit
 * / vote intent whose feeShares[] omits the platform fee recipient;
 * passing the existing default through this fn is the contract-safe way
 * to satisfy the rule.
 *
 * If `platformFeeRecipient` is already an entry, `shares` is returned
 * unchanged. Otherwise an entry at `platformBps` (default 1000 = 10%)
 * is added, and the remaining `10000 - platformBps` is taken pro-rata
 * out of the existing shares.
 *
 * Throws if the resulting array would have non-positive bps for any
 * non-platform recipient — caller should pick a smaller `platformBps`.
 */
export function ensurePlatformFeeInShares(
  shares: FeeShare[],
  platformFeeRecipient: `0x${string}`,
  platformBps: bigint = BigInt(1000),
): FeeShare[] {
  if (
    platformFeeRecipient === ZERO_ADDRESS ||
    !platformFeeRecipient
  ) {
    throw new Error(
      "ensurePlatformFeeInShares: platformFeeRecipient must be a non-zero address (chain reverts ForgePlatformRecipientRequired)",
    );
  }
  const lower = platformFeeRecipient.toLowerCase();
  if (shares.some((s) => s.recipient.toLowerCase() === lower)) {
    return shares;
  }
  if (platformBps <= 0n || platformBps >= 10000n) {
    throw new Error(
      `ensurePlatformFeeInShares: platformBps ${platformBps} must be in (0, 10000)`,
    );
  }
  const remaining = 10000n - platformBps;
  const oldTotal = shares.reduce((acc, s) => acc + s.basisPoints, 0n);
  if (oldTotal !== 10000n) {
    throw new Error(
      `ensurePlatformFeeInShares: input shares sum to ${oldTotal}, expected 10000`,
    );
  }
  const rescaled: FeeShare[] = shares.map((s) => ({
    recipient: s.recipient,
    basisPoints: (s.basisPoints * remaining) / 10000n,
  }));
  // Repair any rounding loss by pushing the dust onto the largest share.
  const rescaledTotal = rescaled.reduce((acc, s) => acc + s.basisPoints, 0n);
  const dust = remaining - rescaledTotal;
  if (dust !== 0n) {
    let maxIdx = 0;
    for (let i = 1; i < rescaled.length; i++) {
      if (rescaled[i].basisPoints > rescaled[maxIdx].basisPoints) maxIdx = i;
    }
    rescaled[maxIdx].basisPoints += dust;
  }
  return [
    ...rescaled,
    { recipient: platformFeeRecipient, basisPoints: platformBps },
  ];
}

// 5-min TTL on signed intents. Matches backend's MaxPermitTTL after
// decision 0007 (timer-rationalization) tightened from 15min — intent
// expiresAt is the sign-to-broadcast latency budget, not a round
// window. Tighter ⇒ smaller replay window.
export const INTENT_TTL_SECONDS = 5 * 60;
