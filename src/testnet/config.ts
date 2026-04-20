// Testnet config — cartridge loop 0061. Source-of-truth for
// everything Base-Sepolia-specific that the wallet + MCP + bootstrap
// code paths need.
//
// Keeping this in one file (rather than reading from YAML) so that
// type-safety travels with the values. YAML-based overrides land
// in loop 62 if needed.

import type { Address } from "viem";

export interface TestnetConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  /** Official USDC on this testnet. Required for L2 participation. */
  usdcAddress: Address;
  /** Block explorer — operator pastes addresses here to check balance. */
  explorerUrl: string;
  /** Where to send users when they need to fund their wallet. */
  faucetHints: {
    nativeEth: string;
    usdc: string;
  };
}

/** Base Sepolia — the chain the backend Oracle keeper also targets
 *  (matches ORACLE_CHAIN_ID + SIGNING_CHAIN_ID defaults of 84532). */
export const BASE_SEPOLIA: TestnetConfig = {
  name: "base-sepolia",
  chainId: 84532,
  rpcUrl: "https://sepolia.base.org",
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  explorerUrl: "https://sepolia.basescan.org",
  faucetHints: {
    nativeEth: "https://www.alchemy.com/faucets/base-sepolia",
    usdc: "https://faucet.circle.com/ (select Base Sepolia)",
  },
};

/** Loads the active testnet config from env. Defaults to Base
 *  Sepolia; RT_AGENT_RPC_URL overrides the RPC endpoint if the
 *  public one is rate-limited. */
export function loadTestnetConfig(): TestnetConfig {
  const rpcOverride = process.env.RT_AGENT_RPC_URL?.trim();
  if (rpcOverride) {
    return { ...BASE_SEPOLIA, rpcUrl: rpcOverride };
  }
  return BASE_SEPOLIA;
}
