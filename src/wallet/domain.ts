// EIP-712 Domain for wallet-login — cartridge loop 0062.
//
// Must match the backend's Config.SigningDomain exactly (name,
// version, chainId, verifyingContract). Any drift makes
// signature recovery on the backend return a different address
// than the one signed for → /auth/wallet rejects.
//
// Backend default: internal/config/config.go loadSigningDomain()
// returns name="RezonTreeOracle" version="1" chainId=84532
// verifyingContract=0x…0001.
//
// Operators who change SIGNING_* env vars on the backend MUST
// set matching RT_AGENT_DOMAIN_* env vars here. Loop 0016's
// cross-config gate on the backend guarantees the backend's own
// domain is self-consistent (chain_id matches Router address);
// the agent mirrors backend-side values without second-guessing.

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
  chainId: 84532, // Base Sepolia; matches backend SIGNING_CHAIN_ID default
  verifyingContract: "0x0000000000000000000000000000000000000001",
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
 *  (internal/signer/wallet_login_intent.go:45). */
export const WALLET_LOGIN_INTENT_TYPES = {
  WalletLoginIntent: [
    { name: "ethAddress", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;
