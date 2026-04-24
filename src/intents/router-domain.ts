// router-domain.ts — EIP-712 domain for Router v2 intents.
//
// Distinct from the wallet-login domain (services/wallet-auth.ts):
// wallet-login targets the Oracle (name="RezonTreeOracle", version="1");
// Router v2 intents target the Router contract (name="RezonTreeRouter",
// version="2"). A mismatch here produces signatures the Router
// rejects on-chain with RouterBadSigner — so every field must match
// Router.sol's constructor-set domain byte-for-byte.
//
// The concrete `verifyingContract` is the deployed Router address.
// Operators set NEXT_PUBLIC_ROUTER_ADDRESS at build time per
// environment (staging / mainnet); dev defaults to the preflight
// response's `router_address` field at runtime, avoiding a build-
// time hard-code in development.

export const ROUTER_DOMAIN_NAME = "RezonTreeRouter" as const;
export const ROUTER_DOMAIN_VERSION = "2" as const;

export interface RouterIntentDomain {
  name: typeof ROUTER_DOMAIN_NAME;
  version: typeof ROUTER_DOMAIN_VERSION;
  chainId: bigint;
  verifyingContract: `0x${string}`;
}

/**
 * Builds the EIP-712 domain for Router v2 intents. Prefer passing
 * values from the server-advertised preflight response so the
 * client stays in lockstep with what the backend signs + what the
 * Router verifies. R-CLIENT-IS-TRUST-ORIGIN — the client builds
 * from advertised params.
 */
export function buildRouterDomain(params: {
  chainId: number | bigint;
  routerAddress: `0x${string}`;
}): RouterIntentDomain {
  const chainId =
    typeof params.chainId === "bigint"
      ? params.chainId
      : BigInt(params.chainId);
  return {
    name: ROUTER_DOMAIN_NAME,
    version: ROUTER_DOMAIN_VERSION,
    chainId,
    verifyingContract: params.routerAddress,
  };
}
