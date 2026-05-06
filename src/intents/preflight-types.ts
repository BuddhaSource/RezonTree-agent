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
// v2.5: FundPreflight discriminates `sponsor` vs `cosponsor` mode
// (replacing v2.4's `init` / `join`). Sponsor-mode preflights
// advertise the full per-Q parameter set the first sponsor binds
// on-chain; cosponsor-mode preflights are minimal — per-Q params
// are inherited from chain state.
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

// RezonForge v2.5 fund preflight: `mode` discriminates sponsor vs
// cosponsor. When mode === "sponsor", the sponsor-only fields
// (oracle, stakeFloor, stakeBasisPoints, sponsorshipFloor,
// voteFee, abandonmentGracePeriod) are populated with backend-
// suggested defaults the sponsor can override before signing.
export interface FundPreflight {
  mode: "sponsor" | "cosponsor";
  qid: string;
  recommendedAmountFloor: string;
  token: TokenPreflight;
  forgeAddress: string;
  chainId: number;
  nonceNext: string;
  fundingDeadline?: number;

  // Sponsor-only suggested defaults.
  oracle?: string;
  stakeFloor?: string;
  stakeBasisPoints?: string;
  sponsorshipFloor?: string;
  voteFee?: string;
  // v2.7 sponsor-only fields.
  commitFee?: string;
  noSolutionGracePeriod?: string;
  // v2.9: feeShareBps is the new Q-level fee rate (replaces v2.8 platformFeeBps).
  // platformFeeBps retained as a deprecated field for transition; new backends
  // emit feeShareBps.
  platformFeeBps?: string;
  feeShareBps?: string;
  platformFeeRecipient?: string;
  abandonmentGracePeriod?: string;
  // v2.10 (C03): recommended sponsor-signed fundingDeadline (unix seconds).
  // Distinct from `fundingDeadline` above (which is the active round's
  // coordination deadline). Populated only in sponsor mode.
  sponsorFundingDeadline?: string;

  _actions: HypermediaAction[];
}

export interface CommitPreflight {
  qid: string;
  feeAmount: string;
  stakeAmount: string;
  token: TokenPreflight;
  forgeAddress: string;
  chainId: number;
  nonceNext: string;
  submissionDeadline?: number;
  // Required to satisfy _validateFeeShareInvariants — the chain rejects
  // a commit whose feeShares[] omits q.platformFeeRecipient.
  platformFeeRecipient?: string;
  _actions: HypermediaAction[];
}

export interface VotePreflight {
  qid: string;
  feeAmount: string;
  stakeAmount: string;
  token: TokenPreflight;
  forgeAddress: string;
  chainId: number;
  nonceNext: string;
  voteDeadline?: number;
  // Required to satisfy _validateFeeShareInvariants — the chain rejects
  // a vote whose feeShares[] omits q.platformFeeRecipient.
  platformFeeRecipient?: string;
  // voteSalt + voteSaltToken are server-issued at preflight and
  // echoed verbatim in the submit body; the salt is mixed into
  // allocationsHash to defeat on-chain rainbow-table enumeration.
  // Absent when the caller didn't pass `?voter=` (preflight can't
  // bind a salt to an unknown voter — the backend rejects at draft time).
  voteSalt?: string;
  voteSaltToken?: string;
  voteSaltExpiresAt?: number;
  _actions: HypermediaAction[];
}
