// modules/wallets/providers/imported.ts — raw private key import.
//
// For wallets the operator already has (e.g., faucet-funded keys, dev
// wallets, key shares from a coordination ceremony). The key itself is
// never persisted in plaintext — it's stored in the OS keychain and
// only the keychain handle goes into provider_data.
//
// Initial implementation uses a simple env-var pointer for portability;
// we'll wire to keytar/macOS-keychain later. The contract here is what
// matters: provider_data has no key material.

import { privateKeyToAccount } from "viem/accounts";
import type { Account, Address, Hex } from "viem";

import type {
  WalletProvider,
  RegisterWalletInput,
  RegisterResult,
} from "./types.js";

interface ImportedProviderData {
  /** Where to find the private key at sign time. */
  keyRef: { kind: "env"; var: string } | { kind: "keychain"; service: string; account: string };
  [key: string]: unknown;
}

export const importedProvider: WalletProvider = {
  type: "imported",

  async register(input: RegisterWalletInput): Promise<RegisterResult> {
    const pk = input.details["private_key"];
    if (typeof pk !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error(
        "imported provider requires details.private_key (0x + 64 hex chars)",
      );
    }
    const account = privateKeyToAccount(pk as Hex);
    const address = account.address.toLowerCase() as Address;

    // Store under an env-var pointer. The operator is expected to set
    // the corresponding env var before running the agent. This keeps
    // the SQLite file safe to share / commit-by-accident — no key
    // material lands on disk via this module.
    const envVar =
      typeof input.details["key_env_var"] === "string"
        ? (input.details["key_env_var"] as string)
        : `RT_KEY_${address.slice(2, 10).toUpperCase()}`;

    const providerData: ImportedProviderData = {
      keyRef: { kind: "env", var: envVar },
    };
    return { address, providerData };
  },

  async loadAccount({ providerData }): Promise<Account> {
    const data = providerData as unknown as ImportedProviderData;
    if (data.keyRef.kind !== "env") {
      throw new Error(
        `imported provider: keyRef.kind=${data.keyRef.kind} not yet supported`,
      );
    }
    const pk = process.env[data.keyRef.var];
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error(
        `imported provider: env var ${data.keyRef.var} missing or malformed`,
      );
    }
    return privateKeyToAccount(pk as Hex);
  },
};
