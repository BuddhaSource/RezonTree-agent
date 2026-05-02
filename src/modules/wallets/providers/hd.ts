// modules/wallets/providers/hd.ts — BIP-44 HD-derived wallets.
//
// Operator stores a single mnemonic in env (RT_AGENT_MNEMONIC); each
// agent address is `m/44'/60'/0'/0/<hd_index>`. We persist the index
// only — the mnemonic stays in env and is never written to the DB.
//
// This is the default provider for testnet / battle-harness use where
// you want N agents from one seed without managing N keys.

import { mnemonicToAccount } from "viem/accounts";
import type { Account, Address } from "viem";

import type {
  WalletProvider,
  RegisterWalletInput,
  RegisterResult,
} from "./types.js";

interface HdProviderData {
  hdIndex: number;
  [key: string]: unknown;
}

const MNEMONIC_ENV = "RT_AGENT_MNEMONIC";

function readMnemonic(): string {
  const m = process.env[MNEMONIC_ENV];
  if (!m || m.trim() === "") {
    throw new Error(
      `${MNEMONIC_ENV} not set — HD provider needs a mnemonic in env.`,
    );
  }
  return m.trim();
}

export const hdProvider: WalletProvider = {
  type: "hd",

  async register(input: RegisterWalletInput): Promise<RegisterResult> {
    const idx = input.details["hd_index"];
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
      throw new Error("hd provider requires details.hd_index >= 0");
    }
    const account = mnemonicToAccount(readMnemonic(), { addressIndex: idx });
    const address = account.address.toLowerCase() as Address;
    const providerData: HdProviderData = { hdIndex: idx };
    return { address, providerData };
  },

  async loadAccount({ providerData }): Promise<Account> {
    const data = providerData as unknown as HdProviderData;
    return mnemonicToAccount(readMnemonic(), { addressIndex: data.hdIndex });
  },
};
