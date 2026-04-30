// settings/base.ts — defaults for all networks.
//
// Django-style settings: a `Settings` object that any module reads via
// `getSettings()`. Network-specific files (testnet.ts, mainnet.ts) extend
// this and override only what differs. `local.ts` (gitignored) lets the
// operator override anything for personal dev.

import type { Address } from "viem";

export type Network = "testnet" | "mainnet";

export interface Settings {
  /** Which chain the agent runs on. Stamped on every action row. */
  NETWORK: Network;
  CHAIN_ID: number;
  RPC_URL: string;
  FORGE_ADDRESS: Address;
  USDC_ADDRESS: Address;
  BACKEND_URL: string;

  /** SQLite file path. One DB shared across all wallets. */
  DATABASE_PATH: string;

  /** Modules to load. Order matters for migrations. */
  INSTALLED_MODULES: string[];

  /** Periodic review cadence — every N seconds an LLM extracts lessons. */
  REVIEW_INTERVAL_SECONDS: number;

  /** Default daily budget per (wallet × role) when not set on the row. */
  DEFAULT_DAILY_BUDGET_USD: number;

  /** Fraction of daily budget reserved for engaging unproven topics. */
  EXPLORATION_RATIO: number;

  /** Model tier mapping — used by the model router. */
  MODELS: {
    default: string;
    deep: string;
    cheap: string;
  };

  /** LLM provider auth. */
  LLM_PROVIDER: "anthropic" | "openrouter" | "bedrock" | "vertex";
  LLM_BASE_URL?: string;

  /** Logger level. */
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

export const base: Settings = {
  NETWORK: "testnet",
  CHAIN_ID: 84532,
  RPC_URL: "https://sepolia.base.org",
  FORGE_ADDRESS: "0x0000000000000000000000000000000000000000",
  USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  BACKEND_URL: "http://localhost:8080",

  DATABASE_PATH: "rezontree.sqlite",

  INSTALLED_MODULES: ["wallets"],

  REVIEW_INTERVAL_SECONDS: 3600,
  DEFAULT_DAILY_BUDGET_USD: 5.0,
  EXPLORATION_RATIO: 0.1,

  MODELS: {
    default: "claude-sonnet-4-6",
    deep: "claude-opus-4-7",
    cheap: "claude-haiku-4-5",
  },

  LLM_PROVIDER: "anthropic",
  LOG_LEVEL: "info",
};
