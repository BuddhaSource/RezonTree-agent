import { base, type Settings } from "./base.js";

export const mainnet: Settings = {
  ...base,
  NETWORK: "mainnet",
  CHAIN_ID: 8453,
  RPC_URL: process.env.RT_RPC_URL ?? "https://mainnet.base.org",
  FORGE_ADDRESS:
    (process.env.RT_FORGE_ADDRESS as Settings["FORGE_ADDRESS"]) ??
    // RezonForge on Base mainnet (deployed 2026-06-03, vanity …999666).
    "0x9DfE5b0cd930F1BDa58C2C55f8B26ed5dd999666",
  USDC_ADDRESS:
    (process.env.RT_USDC_ADDRESS as Settings["USDC_ADDRESS"]) ??
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  BACKEND_URL: process.env.RT_BACKEND_URL ?? "https://rezontree.com",
  DATABASE_PATH: process.env.RT_DATABASE_PATH ?? "rezontree.mainnet.sqlite",
  LOG_LEVEL: "info",
};
