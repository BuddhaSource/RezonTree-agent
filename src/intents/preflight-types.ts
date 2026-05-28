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

// ─── Quadphase v2 envelope template ──────────────────────────────────
//
// QuadphaseEnvelopeTemplate is the v2-additive companion block on every
// preflight/draft response (mirrors RezonTree
// handler.QuadphaseEnvelopeTemplate). It carries the canonical envelope
// JSON the backend hashed to derive expectedIntentHash. `envelope` is
// the serialized protocol.Envelope (signer / questionId / action /
// nonce / expiresAt / contentHash / funds); the bounty token lives at
// `envelope.funds.token`. The SDK reads it to recover the token address
// for a claim/refund draft (the draft response has no top-level token
// field — funds, including the token, are nested inside the envelope).
//
// `envelope` + `witness` are declared as `unknown` here: the backend
// emits them as json.RawMessage and the SDK only narrows the few fields
// it consumes (funds.token) at the read site, never the whole shape.
export interface QuadphaseEnvelopeTemplate {
  envelope: unknown;
  witness: unknown;
  contentHash: string;
  intentHash: string;
  witnessTypehash: string;
  action: string;
  actionTag: number;
}

// ─── Money-out drafts (claim / refund / withdraw) ────────────────────
//
// These mirror RezonTree's handler.ClaimDraftResponse,
// handler.RefundDraftResponse, handler.WithdrawItem, and
// handler.WithdrawDraftResponse exactly. They are the signable drafts
// the unified money-out door (POST /v1/questions/:id/intents/preflight
// with {actionType:"withdraw"}) returns. The SDK consumes them in the
// MCP `withdraw` tool, mapping each draft → runClaimFlow / runRefundFlow
// params.
//
// CRITICAL — each draft carries its own server-allocated RANDOM
// `nonce` (the withdraw door pre-allocates distinct uint256 nonces so N
// intents don't collide on the contract's Permit2-style bitmap) plus
// its own `expectedIntentHash`. The SDK MUST use both VERBATIM and
// never recompute or override the nonce.

/** ClaimDraftResponse — a signable pullValue(Claim) draft for a
 *  winning leaf. Mirrors handler.ClaimDraftResponse. */
export interface ClaimDraftResponse {
  qid: string;
  recipient: string;
  leafIndex: string;
  leafAmount: string;
  /** Role byte for dual-role disambiguation (winner_creator / voter /
   *  sponsor — see the contract enum). */
  role: number;
  proof: string[];
  forgeAddress: string;
  chainId: number;
  /** Server-allocated RANDOM uint256 (decimal string). Use verbatim. */
  nonce: string;
  /** "random" for withdraw-door items; "chain"/"db" for single-action
   *  drafts. Informational — do not branch on it; the chain
   *  re-validates regardless. */
  nonceSource: string;
  recommendedExpiresAt: number;
  expectedIntentHash: string;
  envelopeTemplate: QuadphaseEnvelopeTemplate | null;
  _actions: HypermediaAction[];
}

/** RefundDraftResponse — a signable pullValue(Refund) draft. Sponsor
 *  refund when sourceIntentHash == bytes32(0); commit/vote stake refund
 *  otherwise. Mirrors handler.RefundDraftResponse. */
export interface RefundDraftResponse {
  qid: string;
  signer: string;
  /** bytes32(0) for sponsor refund; the committed solution/vote
   *  intentHash for stake refunds. */
  sourceIntentHash: string;
  expectedAmount: string;
  /** On-chain QuestionStatus enum the signer expects (Abandoned=4,
   *  Settled=3). */
  expectedStatus: number;
  forgeAddress: string;
  chainId: number;
  /** Server-allocated RANDOM uint256 (decimal string). Use verbatim. */
  nonce: string;
  nonceSource: string;
  recommendedExpiresAt: number;
  expectedIntentHash: string;
  envelopeTemplate: QuadphaseEnvelopeTemplate | null;
  _actions: HypermediaAction[];
}

/** WithdrawItem — one signable money-out intent the caller is entitled
 *  to on a question. Exactly one of `claim` / `refund` is set. Mirrors
 *  handler.WithdrawItem. */
export interface WithdrawItem {
  /** "claim" | "refund" */
  actionType: "claim" | "refund";
  /** claim: winner_creator / voter / sponsor; refund: sponsor /
   *  solver_stake / voter_fee. */
  role: string;
  claim?: ClaimDraftResponse;
  refund?: RefundDraftResponse;
}

/** WithdrawDraftResponse — the unified money-out door's payload. ONE
 *  preflight returns EVERY intent the caller is owed on the question.
 *  An empty `eligible` list (eligibleCount === 0) is a valid 200, NOT
 *  an error — the caller is owed nothing here. Mirrors
 *  handler.WithdrawDraftResponse. */
export interface WithdrawDraftResponse {
  qid: string;
  signer: string;
  questionStatus: string;
  eligible: WithdrawItem[];
  eligibleCount: number;
  _actions: HypermediaAction[];
}
