import { base, type Settings } from "./base.js";

export const mainnet: Settings = {
  ...base,
  NETWORK: "mainnet",
  CHAIN_ID: 8453,
  RPC_URL: process.env.RT_RPC_URL ?? "https://mainnet.base.org",
  FORGE_ADDRESS:
    (process.env.RT_FORGE_ADDRESS as Settings["FORGE_ADDRESS"]) ??
    "0x0000000000000000000000000000000000000000",
  USDC_ADDRESS:
    (process.env.RT_USDC_ADDRESS as Settings["USDC_ADDRESS"]) ??
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  BACKEND_URL: process.env.RT_BACKEND_URL ?? "https://api.rezontree.com",
  DATABASE_PATH: process.env.RT_DATABASE_PATH ?? "rezontree.mainnet.sqlite",
  LOG_LEVEL: "info",
};
