// modules/wallets/providers/registry.ts — provider lookup.
//
// Adding a new provider is one line here plus the implementation file.

import type { ProviderType, WalletProvider } from "./types.js";
import { hdProvider } from "./hd.js";
import { importedProvider } from "./imported.js";
import { privyProvider } from "./privy.js";

const REGISTRY: Record<ProviderType, WalletProvider> = {
  hd: hdProvider,
  imported: importedProvider,
  privy: privyProvider,
};

export function getProvider(type: ProviderType): WalletProvider {
  const p = REGISTRY[type];
  if (!p) throw new Error(`Unknown wallet provider type: ${type}`);
  return p;
}

export function listProviderTypes(): ProviderType[] {
  return Object.keys(REGISTRY) as ProviderType[];
}
