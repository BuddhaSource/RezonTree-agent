// login.ts — the canonical "mnemonic + index → JWT" path for the SDK.
//
// One home for fleet login. Wraps SessionManager (the per-wallet JWT cache in
// session.ts) behind a process-wide manager-per-apiBase so the whole fleet
// logs in once per wallet and reuses the token across actions. Previously this
// lived in scripts/lib/operator-recovery.ts; it belongs in the wallet library
// so every harness, operator script, and the get-started bootstrap share ONE
// login path instead of each constructing its own SessionManager.
//
// Behaviour is unchanged from the prior operator-recovery copy — this is a
// relocation, not a rewrite. The WalletLoginIntent signing (signer.ts) and the
// HTTP login (session.ts) are untouched, so the wire output is byte-identical.

import type { Address, Hex } from "viem";

import { deriveAgentWallet } from "./derive.js";
import { loadLoginDomain } from "./domain.js";
import { SessionManager } from "./session.js";

export interface DerivedWallet {
  index: number;
  address: Address;
  privateKey: Hex;
}

/** Derive idx 0..size-1 from the mnemonic, keyed by lowercase address. Uses
 *  the same BIP-44 path (m/44'/60'/0'/0/<idx>) as the rest of the fleet
 *  tooling via deriveAgentWallet. */
export function buildWalletBank(
  mnemonic: string,
  size: number,
  chainId: number,
): Map<string, DerivedWallet> {
  const bank = new Map<string, DerivedWallet>();
  for (let i = 0; i < size; i++) {
    const w = deriveAgentWallet(mnemonic, i, chainId);
    bank.set(w.address.toLowerCase(), {
      index: i,
      address: w.address as Address,
      privateKey: w.privateKey as Hex,
    });
  }
  return bank;
}

// Process-wide session cache so repeated loginWallet() calls for the same
// wallet reuse one JWT (login once, reuse across actions). Keyed by apiBase
// since one process may target multiple backends in a test.
const sessionManagers = new Map<string, SessionManager>();

/** The shared SessionManager for an apiBase — constructed once per process.
 *  Harnesses should call this instead of `new SessionManager(...)` so the
 *  whole fleet shares one login cache. */
export function sessionManagerFor(apiBase: string): SessionManager {
  const base = apiBase.replace(/\/$/, "");
  let mgr = sessionManagers.get(base);
  if (!mgr) {
    mgr = new SessionManager({ apiBase: base, domain: loadLoginDomain() });
    sessionManagers.set(base, mgr);
  }
  return mgr;
}

/** Sign a WalletLoginIntent for the given HD index and exchange it for a
 *  backend JWT via POST /v1/sessions, through the shared SessionManager
 *  (first call per wallet logs in; later calls reuse the cached token,
 *  collapsing the per-action login fan-out). */
export async function loginWallet(
  apiBase: string,
  mnemonic: string,
  walletIdx: number,
): Promise<{ bearer: string; address: Address; privateKey: Hex }> {
  const domain = loadLoginDomain();
  const wallet = deriveAgentWallet(mnemonic, walletIdx, domain.chainId);
  const bearer = await sessionManagerFor(apiBase).ensureToken(wallet);
  return {
    bearer,
    address: wallet.address as Address,
    privateKey: wallet.privateKey as Hex,
  };
}
