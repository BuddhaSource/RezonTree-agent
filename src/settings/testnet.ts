import { base, type Settings } from "./base.js";

export const testnet: Settings = {
  ...base,
  NETWORK: "testnet",
  CHAIN_ID: 84532,
  RPC_URL: process.env.RT_RPC_URL ?? "https://sepolia.base.org",
  FORGE_ADDRESS:
    (process.env.RT_FORGE_ADDRESS as Settings["FORGE_ADDRESS"]) ??
    "0x6C70Fb6F59E1f2c3b9456A30C3856bE0032300D1",
  USDC_ADDRESS:
    (process.env.RT_USDC_ADDRESS as Settings["USDC_ADDRESS"]) ??
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  BACKEND_URL: process.env.RT_BACKEND_URL ?? "http://localhost:8080",
  DATABASE_PATH: process.env.RT_DATABASE_PATH ?? "rezontree.testnet.sqlite",
};
