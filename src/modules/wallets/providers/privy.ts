// modules/wallets/providers/privy.ts — Privy embedded wallet (stub).
//
// Privy hosts a key on behalf of an end user; signing requires a user
// session token. Useful when the agent is acting on behalf of a logged-
// in human (RezonTree-UI users, for example).
//
// This file is intentionally a stub. It declares the shape so the
// registry can route to it, but throws on actual use until the Privy
// integration is wired (Privy server SDK + user JWT verification).

import type { Account, Address } from "viem";

import type {
  WalletProvider,
  RegisterWalletInput,
  RegisterResult,
} from "./types.js";

interface PrivyProviderData {
  privyUserId: string;
  embeddedWalletId: string;
}

export const privyProvider: WalletProvider = {
  type: "privy",

  async register(input: RegisterWalletInput): Promise<RegisterResult> {
    const userId = input.details["privy_user_id"];
    const walletId = input.details["embedded_wallet_id"];
    const address = input.details["address"];
    if (
      typeof userId !== "string" ||
      typeof walletId !== "string" ||
      typeof address !== "string"
    ) {
      throw new Error(
        "privy provider requires details: privy_user_id, embedded_wallet_id, address",
      );
    }
    const providerData: PrivyProviderData = {
      privyUserId: userId,
      embeddedWalletId: walletId,
    };
    return { address: address.toLowerCase() as Address, providerData };
  },

  async loadAccount(_args): Promise<Account> {
    throw new Error(
      "privy provider: signing not yet implemented. Wire Privy server SDK + user-session relay before enabling this provider.",
    );
  },
};
