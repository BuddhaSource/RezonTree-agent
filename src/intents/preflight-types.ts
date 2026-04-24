// preflight-types.ts — response shapes for the backend's per-flow
// preflight endpoints (backend loop 0038). Mirrors
// RezonTree-UI/src/services/preflight.ts types exactly; any drift
// lands as an SDK VALIDATION_ERROR when the agent POSTs the
// resulting intent.
//
// The SDK's existing `src/bootstrap/preflight.ts` is a different
// thing — it's a startup health check that pings the backend to
// confirm it's reachable. These types describe the per-flow
// preflight shapes (/fund/preflight, /commit/preflight,
// /vote/preflight) that the intent builders consume.

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

export interface FundPreflight {
  qid: string;
  recommended_amount_floor: string;
  token: TokenPreflight;
  router_address: string;
  chain_id: number;
  nonce_next: string;
  funding_deadline?: number;
  _actions: HypermediaAction[];
}

export interface CommitPreflight {
  qid: string;
  recommended_fee: string;
  recommended_bond: string;
  token: TokenPreflight;
  router_address: string;
  chain_id: number;
  nonce_next: string;
  submission_deadline?: number;
  _actions: HypermediaAction[];
}

export interface VotePreflight {
  qid: string;
  recommended_fee: string;
  recommended_bond: string;
  token: TokenPreflight;
  router_address: string;
  chain_id: number;
  nonce_next: string;
  vote_deadline?: number;
  _actions: HypermediaAction[];
}
