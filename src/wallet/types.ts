// Type scaffolding for the wallet package — cartridge loop 0061.
// Concrete implementations land in loop 62. This file pins the
// shapes loop-62 work needs to fit, and makes the migration-plan
// commitments explicit in code.

import type { Address, Hex } from "viem";

/**
 * AgentWallet is everything an agent needs to sign + transact on
 * Base Sepolia. Derived at startup from the mnemonic + HD path;
 * never persisted.
 */
export interface AgentWallet {
  /** Zero-based index in the YAML agent list; maps to HD path
   *  m/44'/60'/0'/0/<agentIndex>. */
  agentIndex: number;
  /** Lowercase 0x-prefixed EVM address. */
  address: Address;
  /** In-memory private key. Never logged, never persisted. */
  privateKey: Hex;
  /** Chain id the wallet is bound to for EIP-712 signing +
   *  balance queries. Matches backend SIGNING_CHAIN_ID. */
  chainId: number;
}

/**
 * WalletLoginIntent mirrors the backend's
 * internal/signer/wallet_login_intent.go typed-message. Field
 * order + names must match byte-for-byte or signature recovery
 * fails on the backend.
 */
export interface WalletLoginIntent {
  ethAddress: Address;
  chainId: bigint;
  issuedAt: bigint;
}

/**
 * SignedWalletLoginIntent is what /auth/wallet wants:
 * { address, chain_id, issued_at, signature }.
 */
export interface SignedWalletLoginIntent {
  address: Address;
  chain_id: number;
  issued_at: number;
  signature: Hex;
}

/**
 * BalanceSnapshot — result of a one-shot `getAgentBalance` call.
 * Both fields are bigint wei / 6-decimal minor units (USDC has
 * 6 decimals on Base); the consumer decides on display format.
 */
export interface BalanceSnapshot {
  address: Address;
  chainId: number;
  nativeWei: bigint;
  usdcMinor: bigint;
  /** Unix seconds at which the snapshot was taken. */
  at: number;
}

/**
 * FundingThreshold is the minimum balance an agent needs before
 * it's "ready to participate." Used by the bootstrap script to
 * block until the user has funded an address.
 */
export interface FundingThreshold {
  /** Minimum native ETH in wei; default enough for ~5 claim txs. */
  minNativeWei: bigint;
  /** Minimum USDC in minor units; default $10 for L2 participation. */
  minUsdcMinor: bigint;
}

export const DEFAULT_FUNDING_THRESHOLD: FundingThreshold = {
  // 0.005 Sepolia ETH — enough for ~5 claim txs at typical
  // Base Sepolia gas prices. Users with cheaper faucets can
  // override via config.
  minNativeWei: 2_000_000_000_000_000n,
  // $1 USDC at 6 decimals.
  minUsdcMinor: 1_000_000n,
};
