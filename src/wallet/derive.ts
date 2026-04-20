// HD wallet derivation — cartridge loop 0062.
//
// One BIP-39 mnemonic → N agent wallets via BIP-44 path
// m/44'/60'/0'/0/<agentIndex>. Single backup phrase, N
// independent addresses.
//
// The mnemonic lives in RT_AGENT_MNEMONIC (.env, git-ignored).
// Private keys derived in-memory at agent startup; never persisted.
// Each agent's address is stable across restarts as long as the
// mnemonic + index are unchanged.

import {
  type HDAccount,
  english,
  generateMnemonic,
  mnemonicToAccount,
} from "viem/accounts";

import type { AgentWallet } from "./types.js";

/**
 * Derive the wallet for a single agent from a mnemonic.
 *
 * @throws when the mnemonic fails BIP-39 validation — viem's
 *   `mnemonicToAccount` itself throws on bad checksum / word
 *   count, which we surface with our own message so the stack
 *   trace points at the env var, not at viem internals.
 */
export function deriveAgentWallet(
  mnemonic: string,
  agentIndex: number,
  chainId: number,
): AgentWallet {
  if (!Number.isInteger(agentIndex) || agentIndex < 0) {
    throw new Error(
      `agentIndex must be a non-negative integer, got ${agentIndex}`,
    );
  }

  // viem accepts either a numeric accountIndex (which becomes
  // m/44'/60'/<accountIndex>'/0/0) OR a full path. We want the
  // LAST segment to vary per agent, not the account segment —
  // all agents share one BIP-44 "account 0" and differ at the
  // address index. This keeps the derivation scheme predictable
  // for external tooling (block explorers, seed wallets).
  let account: HDAccount;
  try {
    account = mnemonicToAccount(mnemonic, {
      path: `m/44'/60'/0'/0/${agentIndex}`,
    });
  } catch (err) {
    throw new Error(
      `RT_AGENT_MNEMONIC failed BIP-39 derivation (bad checksum or word count): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // viem's HDAccount exposes getHdKey() → privateKey. The HD
  // key's private field is a Uint8Array; we hex-encode for the
  // AgentWallet contract. Never log this.
  const privateKey = account.getHdKey().privateKey;
  if (!privateKey) {
    throw new Error("HD derivation failed: missing private key (bug)");
  }
  const privateKeyHex = `0x${Buffer.from(privateKey).toString("hex")}` as `0x${string}`;

  return {
    agentIndex,
    address: account.address,
    privateKey: privateKeyHex,
    chainId,
  };
}

/**
 * Derive N agent wallets in one shot. Use for
 * `testnet-bootstrap.sh` (loop 65) where the operator wants
 * all addresses listed up front so they can fund them.
 */
export function deriveAgentWallets(
  mnemonic: string,
  agentCount: number,
  chainId: number,
): AgentWallet[] {
  if (!Number.isInteger(agentCount) || agentCount <= 0) {
    throw new Error(`agentCount must be positive, got ${agentCount}`);
  }
  const wallets: AgentWallet[] = [];
  for (let i = 0; i < agentCount; i++) {
    wallets.push(deriveAgentWallet(mnemonic, i, chainId));
  }
  return wallets;
}

/** Convenience for tests + local-dev tooling. The Hardhat
 *  standard test mnemonic — NEVER use in production. */
export const HARDHAT_TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

export { generateMnemonic, english };
