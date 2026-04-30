// modules/wallets/providers/types.ts — pluggable wallet provider interface.
//
// A wallet provider is anything that can produce a viem `Account` for a
// known address. The shape is deliberately small so we can support:
//   - HD-derived (BIP-44 from mnemonic + index)
//   - Imported raw private key
//   - Privy embedded wallet (user-bound, fetched at sign time)
//   - Future: Safe / WalletConnect / hardware
//
// `providerData` is the JSON blob persisted in the `wallets.provider_data`
// column. Each provider knows how to deserialize its own shape.

import type { Account, Address } from "viem";

export type ProviderType = "hd" | "imported" | "privy";

export interface RegisterWalletInput {
  /** Optional human label, unique per network. */
  alias?: string;
  /** Provider-specific input the provider knows how to interpret. */
  details: Record<string, unknown>;
}

export interface RegisterResult {
  address: Address;
  providerData: Record<string, unknown>; // persisted on the row
}

export interface WalletProvider {
  readonly type: ProviderType;

  /**
   * Validate input and produce the values to persist on a new row.
   * Should NOT write to the DB — service.ts does that.
   */
  register(input: RegisterWalletInput): Promise<RegisterResult>;

  /**
   * Hydrate a viem Account for a stored wallet. Called at sign time,
   * never at register time. Lets remote-key providers (Privy) defer
   * the round-trip until the agent actually needs to sign.
   */
  loadAccount(args: {
    address: Address;
    providerData: Record<string, unknown>;
  }): Promise<Account>;
}
