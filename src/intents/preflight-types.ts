// preflight-types.ts — response shapes for the backend's per-flow
// preflight endpoints. Mirrors RezonTree-UI's preflight types
// exactly; any drift lands as an SDK VALIDATION_ERROR when the
// agent POSTs the resulting intent.
//
// The SDK's existing `src/bootstrap/preflight.ts` is a different
// thing — it's a startup health check that pings the backend to
// confirm it's reachable. These types describe the per-flow
// preflight shapes (/sponsorships/draft, /solutions/draft,
// /votes/draft) that the intent builders consume.
//
// FundPreflight discriminates `sponsor` vs `cosponsor` mode.
// Sponsor-mode preflights advertise the full per-Q parameter set the
// first sponsor binds on-chain; cosponsor-mode preflights are
// minimal — per-Q params are inherited from chain state.
//
// R-NAME-MATCHES-CHAIN — wire fields are camelCase, mirroring the
// backend's JSON tags. No snake_case, no short aliases.

export interface TokenPreflight {
  contractAddress: string;
  decimals: number;
  symbol: string;
  chainId: number;
}

export interface HypermediaAction {
  rel: string;
  href: string;
  method: string;
  desc?: string;
}

// Fund preflight: `mode` discriminates sponsor vs cosponsor. When
// mode === "sponsor", the sponsor-only fields (oracle, stakeFloor,
// stakeBasisPoints, sponsorshipFloor, voteFee,
// abandonmentGracePeriod) are populated with backend-suggested
// defaults the sponsor can override before signing.
// CallerStatus is the optional balance gate the backend tacks onto a
// preflight when the caller-address query param is supplied. Composite
// tools read `sufficient` and short-circuit before signing.
//
// Carries its own `token` reference + decimal-aware `*Formatted`
// strings so logs and error displays don't have to back-reference the
// parent preflight's token block (Aave/Uniswap pattern).
export interface CallerStatus {
  address: string;
  token: TokenPreflight;
  balanceRaw: string;
  balanceFormatted: string;
  requiredRaw: string;
  requiredFormatted: string;
  shortfallRaw: string;
  shortfallFormatted: string;
  sufficient: boolean;
  topupHint?: string;
}

export interface FundPreflight {
  mode: "sponsor" | "cosponsor";
  qid: string;
  /** Server-recomputed EIP-712 intent hash. Posted verbatim on the
   *  unified submit so the dispatcher rejects client recompute drift
   *  before any Stage-2 work. Optional only because some legacy stub
   *  paths emit the canonical zero-sentinel. */
  expectedIntentHash?: string;
  recommendedSponsorshipFloor: string;
  token: TokenPreflight;
  forgeAddress: string;
  chainId: number;
  nonce: string;
  // Provenance of `nonce` — "chain" when sourced from the live
  // RezonForge contract (preferred), "db" when the chain RPC was
  // unreachable and the backend fell back to its local nonce mirror.
  // SDK callers can log this for race-condition diagnosis but should
  // not branch on it; the chain re-validates regardless.
  nonceSource?: "chain" | "db";
  // Server-recommended absolute unix-second timestamp the client
  // SHOULD use as `expiresAt` when signing — matches the chain field
  // shape (absolute, not a relative duration) so the value passes
  // through unchanged.
  recommendedExpiresAt?: number;
  // Active round's coordination deadline (off-chain — populated in
  // cosponsor mode when a round is open). Named `roundFundingDeadline`
  // to avoid collision with the chain's per-question fundingDeadline
  // field on SponsorIntent.
  roundFundingDeadline?: number;

  // Sponsor-only suggested defaults.
  oracle?: string;
  stakeFloor?: string;
  stakeBasisPoints?: string;
  sponsorshipFloor?: string;
  voteFee?: string;
  commitFee?: string;
  noSolutionGracePeriod?: string;
  // feeShareBps is the Q-level fee rate. platformFeeBps retained as a
  // deprecated field for transition with legacy backends; new backends
  // emit feeShareBps.
  platformFeeBps?: string;
  feeShareBps?: string;
  platformFeeRecipient?: string;
  abandonmentGracePeriod?: string;
  // Recommended sponsor-signed fundingDeadline (unix seconds).
  // Distinct from `fundingDeadline` above (which is the active round's
  // coordination deadline). Populated only in sponsor mode.
  recommendedFundingDeadline?: string;

  caller?: CallerStatus;
  _actions: HypermediaAction[];
}

export interface CommitPreflight {
  qid: string;
  /** Server-recomputed EIP-712 intent hash. See FundPreflight. */
  expectedIntentHash?: string;
  feeAmount: string;
  stakeAmount: string;
  token: TokenPreflight;
  forgeAddress: string;
  chainId: number;
  nonce: string;
  // See FundPreflight.nonceSource — "chain" preferred, "db" fallback.
  nonceSource?: "chain" | "db";
  recommendedExpiresAt?: number;
  submissionDeadline?: number;
  // Required to satisfy _validateFeeShareInvariants — the chain rejects
  // a commit whose feeShares[] omits q.platformFeeRecipient.
  platformFeeRecipient?: string;
  // Frozen per-question fee-share policy as captured by the initial
  // sponsor. The chain reverts a commit whose CommitWitness.feeShares
  // doesn't bit-for-bit match these values. Both fields are absent
  // when the question has no confirmed initial sponsor yet (pre-
  // sponsor preflight); the client must abort rather than substitute
  // a default. (#619)
  feeShareBps?: number;
  feeShares?: { recipient: string; basisPoints: number }[];
  caller?: CallerStatus;
  _actions: HypermediaAction[];
}

export interface VotePreflight {
  qid: string;
  /** Server-recomputed EIP-712 intent hash. See FundPreflight. */
  expectedIntentHash?: string;
  feeAmount: string;
  stakeAmount: string;
  token: TokenPreflight;
  forgeAddress: string;
  chainId: number;
  nonce: string;
  // See FundPreflight.nonceSource — "chain" preferred, "db" fallback.
  nonceSource?: "chain" | "db";
  recommendedExpiresAt?: number;
  voteDeadline?: number;
  // Required to satisfy _validateFeeShareInvariants — the chain rejects
  // a vote whose feeShares[] omits q.platformFeeRecipient.
  platformFeeRecipient?: string;
  // Frozen per-question fee-share policy (same as CommitPreflight). The
  // chain reverts a vote whose VoteWitness.feeShares doesn't match. (#619)
  feeShareBps?: number;
  feeShares?: { recipient: string; basisPoints: number }[];
  // voteSalt + voteSaltToken are server-issued at preflight and
  // echoed verbatim in the submit body; the salt is mixed into
  // allocationsHash to defeat on-chain rainbow-table enumeration.
  // Absent when the caller didn't pass `?voter=` (preflight can't
  // bind a salt to an unknown voter — the backend rejects at draft time).
  voteSalt?: string;
  voteSaltToken?: string;
  voteSaltExpiresAt?: number;
  caller?: CallerStatus;
  _actions: HypermediaAction[];
}
