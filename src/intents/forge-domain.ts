// forge-domain.ts — EIP-712 domain for RezonForge intents.
//
// Distinct from the wallet-login domain (services/wallet-auth.ts):
// wallet-login targets the Oracle (name="RezonTreeOracle", version="1");
// RezonForge intents target the on-chain RezonForge contract
// (name="RezonForge", version=DOMAIN_VERSION_HASH from RezonForge.sol).
// A mismatch here produces signatures the contract rejects on-chain
// with a bad-signer revert — so every field must match RezonForge.sol's
// constructor-set domain byte-for-byte.
//
// The concrete `verifyingContract` is the deployed RezonForge address.
// Operators set RT_FORGE_ADDRESS / NEXT_PUBLIC_FORGE_ADDRESS at build
// time per environment (staging / mainnet); dev defaults to the
// preflight response's `forge_address` field at runtime, avoiding a
// build-time hard-code in development.

export const FORGE_DOMAIN_NAME = "RezonForge" as const;
// R-NO-VERSION-THEATER: matches the deployed Base Sepolia contract's
// DOMAIN_VERSION_HASH = keccak256(bytes("2.10")) at
// contracts/src/RezonForge.sol line 186. Off-chain layers mirror the
// chain string; the launch redeploy bumps to "1.0" in one shot.
// Kept in lockstep with internal/config/config.go LoadForgeSigningDomain,
// RezonTree-UI/lib/intents/forge-domain.ts, and the golden envelope
// vectors. Drift caught by domain_version_coherence_test.go.
export const FORGE_DOMAIN_VERSION = "2.10" as const;

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
  forgeAddress: `0x${string}`;
}): ForgeIntentDomain {
  const chainId =
    typeof params.chainId === "bigint"
      ? params.chainId
      : BigInt(params.chainId);
  return {
    name: FORGE_DOMAIN_NAME,
    version: FORGE_DOMAIN_VERSION,
    chainId,
    verifyingContract: params.forgeAddress,
  };
}
