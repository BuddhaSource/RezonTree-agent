// forge-domain.ts — EIP-712 domain for RezonForge intents (v2.5).
//
// Distinct from the wallet-login domain (services/wallet-auth.ts):
// wallet-login targets the Oracle (name="RezonTreeOracle", version="1");
// RezonForge intents target the on-chain RezonForge contract
// (name="RezonForge", version="2.5"). A mismatch here produces
// signatures the contract rejects on-chain with a bad-signer revert —
// so every field must match RezonForge.sol's constructor-set domain
// byte-for-byte.
//
// The concrete `verifyingContract` is the deployed RezonForge address.
// Operators set RT_ROUTER_ADDRESS / NEXT_PUBLIC_ROUTER_ADDRESS at
// build time per environment (staging / mainnet); dev defaults to
// the preflight response's `router_address` field at runtime,
// avoiding a build-time hard-code in development.

export const FORGE_DOMAIN_NAME = "RezonForge" as const;
export const FORGE_DOMAIN_VERSION = "2.5" as const;

export interface ForgeIntentDomain {
  name: typeof FORGE_DOMAIN_NAME;
  version: typeof FORGE_DOMAIN_VERSION;
  chainId: bigint;
  verifyingContract: `0x${string}`;
}

/**
 * Builds the EIP-712 domain for RezonForge intents. Prefer passing
 * values from the server-advertised preflight response so the
 * client stays in lockstep with what the backend signs + what the
 * contract verifies. R-CLIENT-IS-TRUST-ORIGIN — the client builds
 * from advertised params.
 */
export function buildForgeDomain(params: {
  chainId: number | bigint;
  routerAddress: `0x${string}`;
}): ForgeIntentDomain {
  const chainId =
    typeof params.chainId === "bigint"
      ? params.chainId
      : BigInt(params.chainId);
  return {
    name: FORGE_DOMAIN_NAME,
    version: FORGE_DOMAIN_VERSION,
    chainId,
    verifyingContract: params.routerAddress,
  };
}
