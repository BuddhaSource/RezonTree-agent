#!/usr/bin/env tsx
// scripts/probe-auth.ts — probe POST /auth/wallet with the canonical
// 3-field WalletLoginIntent + RezonTreeOracle domain.

import "dotenv/config";
import { mnemonicToAccount } from "viem/accounts";
import { http, createWalletClient } from "viem";
import { baseSepolia } from "viem/chains";

const mn = process.env.RT_AGENT_MNEMONIC!;
if (!mn) throw new Error("RT_AGENT_MNEMONIC required");
const idx = Number(process.env.IDX ?? 1);

const acc = mnemonicToAccount(mn, { addressIndex: idx });
const wallet = createWalletClient({ account: acc, chain: baseSepolia, transport: http() });

const domain = {
  name: process.env.PROBE_NAME ?? "RezonTreeOracle",
  version: process.env.PROBE_VERSION ?? "1",
  chainId: Number(process.env.PROBE_CHAIN ?? 84532),
  verifyingContract:
    (process.env.PROBE_VC as `0x${string}`) ??
    "0x0000000000000000000000000000000000000001",
};

const expiresAt = Math.floor(Date.now() / 1000) + 600;

const sig = await wallet.signTypedData({
  account: acc,
  domain,
  types: {
    WalletLoginIntent: [
      { name: "ethAddress", type: "address" },
      { name: "chainId", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ],
  },
  primaryType: "WalletLoginIntent",
  message: {
    ethAddress: acc.address,
    chainId: BigInt(84532),
    expiresAt: BigInt(expiresAt),
  },
});

const r = await fetch("http://localhost:8080/auth/wallet", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: acc.address,
    chainId: 84532,
    expiresAt: expiresAt,
    signature: sig,
  }),
});

console.log(`probing idx=${idx} domain=${JSON.stringify(domain)}`);
console.log(`  -> status ${r.status}: ${(await r.text()).slice(0, 200)}`);
