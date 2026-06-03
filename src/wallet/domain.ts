// EIP-712 Domain for wallet-login
//
// Must match the backend's Config.SigningDomain exactly (name,
// version, chainId, verifyingContract). Any drift makes
// signature recovery on the backend return a different address
// than the one signed for → /auth/wallet rejects.
//
// Production default mirrors the backend's mainnet signing domain:
// name="RezonTreeOracle" version="1" chainId=8453 (Base mainnet)
// verifyingContract = the live RezonForge (…999666). The login domain's
// verifyingContract MUST equal the deployed forge, or backend signature
// recovery returns a different address and login 401s.
//
// For Base Sepolia (internal/dev), override via RT_AGENT_DOMAIN_* env
// (RT_AGENT_DOMAIN_CHAIN_ID=84532 + the Sepolia forge). Operators who
// change SIGNING_* env vars on the backend MUST set matching
// RT_AGENT_DOMAIN_* here. Loop 0016's cross-config gate guarantees the
// backend's own domain is self-consistent (chain_id matches Router
// address); the agent mirrors backend-side values without second-guessing.

import type { Address } from "viem";

export interface LoginDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export const DEFAULT_LOGIN_DOMAIN: LoginDomain = {
  name: "RezonTreeOracle",
  version: "1",
  chainId: 8453, // Base mainnet; matches backend SIGNING_CHAIN_ID
  verifyingContract: "0x9DfE5b0cd930F1BDa58C2C55f8B26ed5dd999666",
};

export function loadLoginDomain(): LoginDomain {
  return {
    name: process.env.RT_AGENT_DOMAIN_NAME ?? DEFAULT_LOGIN_DOMAIN.name,
    version: process.env.RT_AGENT_DOMAIN_VERSION ?? DEFAULT_LOGIN_DOMAIN.version,
    chainId:
      Number.parseInt(process.env.RT_AGENT_DOMAIN_CHAIN_ID ?? "", 10) ||
      DEFAULT_LOGIN_DOMAIN.chainId,
    verifyingContract:
      (process.env.RT_AGENT_DOMAIN_VERIFYING_CONTRACT as Address | undefined) ??
      DEFAULT_LOGIN_DOMAIN.verifyingContract,
  };
}

/** Type-set for signTypedData — field order + types must match
 *  backend `WalletLoginIntent` struct byte-for-byte
 *  (internal/signer/wallet_login_intent.go:45).
 *  Loop 0036 migrated `issuedAt` → `expiresAt`; this file
 *  caught up as part of the end-to-end runbook work. Prior
 *  `issuedAt` shape produced a struct hash the backend's
 *  signature recovery rejected. */
export const WALLET_LOGIN_INTENT_TYPES = {
  WalletLoginIntent: [
    { name: "ethAddress", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/** Default TTL for a wallet-login intent. Backend ceiling is 15
 *  min (internal/auth/auth_service.go:WalletLoginMaxTTL); we pick
 *  5 min to leave margin for wallet prompt + network RTT. */
export const DEFAULT_LOGIN_TTL_SECONDS = 5 * 60;
