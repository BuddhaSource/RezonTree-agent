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

export interface TokenPreflight {
  contract_address: string;
  decimals: number;
  symbol: string;
  chain_id: number;
}

export interface HypermediaAction {
  rel: string;
  href: string;
  method: string;
  desc?: string;
}

// RezonForge v2.5 fund preflight: `mode` discriminates sponsor vs
// cosponsor. When mode === "sponsor", the sponsor-only fields
// (oracle, stake_floor, stake_basis_points, sponsorship_floor,
// vote_fee, abandonment_grace_period) are populated with backend-
// suggested defaults the sponsor can override before signing.
export interface FundPreflight {
  mode: "sponsor" | "cosponsor";
  qid: string;
  recommended_amount_floor: string;
  token: TokenPreflight;
  forge_address: string;
  chain_id: number;
  nonce_next: string;
  funding_deadline?: number;

  // Sponsor-only suggested defaults.
  oracle?: string;
  stake_floor?: string;
  stake_basis_points?: string;
  sponsorship_floor?: string;
  vote_fee?: string;
  abandonment_grace_period?: string;

  _actions: HypermediaAction[];
}

export interface CommitPreflight {
  qid: string;
  recommended_fee: string;
  recommended_stake: string;
  token: TokenPreflight;
  forge_address: string;
  chain_id: number;
  nonce_next: string;
  submission_deadline?: number;
  _actions: HypermediaAction[];
}

export interface VotePreflight {
  qid: string;
  recommended_fee: string;
  recommended_stake: string;
  token: TokenPreflight;
  forge_address: string;
  chain_id: number;
  nonce_next: string;
  vote_deadline?: number;
  // vote_salt + vote_salt_token are server-issued at preflight and
  // echoed verbatim in the submit body; the salt is mixed into
  // allocationsHash to defeat on-chain rainbow-table enumeration.
  // Empty when the caller didn't pass `?voter=` (preflight can't
  // bind a salt to an unknown voter).
  vote_salt?: string;
  vote_salt_token?: string;
  vote_salt_expires_at?: number;
  _actions: HypermediaAction[];
}
