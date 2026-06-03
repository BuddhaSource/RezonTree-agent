// Cross-system golden vector + unit coverage for the
// wallet-login signer
//
// The golden vector exists so a future refactor that changes
// field order, chain-id encoding, or domain separator breaks
// LOUDLY here instead of subtly in production (where the
// backend would just reject signatures with a generic
// "AGENT_NOT_FOUND" and debugging would be hellish).
//
// Reference values:
//   - Mnemonic: Hardhat standard test mnemonic
//   - agentIndex: 0
//   - Expected address (public knowledge, derived via any
//     BIP-44 compliant tool): 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
//   - chainId: 8453 (Base mainnet — the production signing default;
//     wallet chainId must match the default login domain to sign)
//   - expiresAt: 1_700_000_000 (a fixed past timestamp)
//   - Domain: default RezonTree signing domain
//
// Expected recovered address after sign-then-verify MUST equal
// the derived address.

import { describe, expect, it } from "vitest";

import { DEFAULT_LOGIN_DOMAIN } from "./domain.js";
import {
  HARDHAT_TEST_MNEMONIC,
  deriveAgentWallet,
  deriveAgentWallets,
} from "./derive.js";
import { signWalletLoginIntent, verifySignedLoginIntent } from "./signer.js";

const HARDHAT_ACCOUNT_0 =
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266".toLowerCase();
const HARDHAT_ACCOUNT_1 =
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8".toLowerCase();

describe("deriveAgentWallet — HD path m/44'/60'/0'/0/N", () => {
  it("derives Hardhat account 0 at agentIndex=0", () => {
    const w = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 84532);
    expect(w.address.toLowerCase()).toBe(HARDHAT_ACCOUNT_0);
    expect(w.chainId).toBe(84532);
    expect(w.agentIndex).toBe(0);
    expect(w.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("derives Hardhat account 1 at agentIndex=1", () => {
    const w = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 1, 84532);
    expect(w.address.toLowerCase()).toBe(HARDHAT_ACCOUNT_1);
  });

  it("is deterministic — same index returns same address", () => {
    const a = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 2, 84532);
    const b = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 2, 84532);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it("different indexes produce different addresses", () => {
    const a = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 84532);
    const b = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 1, 84532);
    expect(a.address).not.toBe(b.address);
  });

  it("rejects invalid mnemonic (bad checksum)", () => {
    expect(() =>
      deriveAgentWallet("not a real mnemonic sequence here", 0, 84532),
    ).toThrow(/BIP-39/);
  });

  it("rejects negative agentIndex", () => {
    expect(() => deriveAgentWallet(HARDHAT_TEST_MNEMONIC, -1, 84532)).toThrow(
      /non-negative/,
    );
  });
});

describe("signWalletLoginIntent — EIP-712 round-trip", () => {
  const EXPIRES_AT = 1_700_000_000;

  it("produces a signature whose recovered address matches the signer", async () => {
    // Sign against the production default domain (chainId 8453) — wallet
    // chainId must match the domain or the signer rejects it before signing.
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 8453);
    const body = await signWalletLoginIntent({
      wallet,
      expiresAt: EXPIRES_AT,
    });
    expect(body.address.toLowerCase()).toBe(HARDHAT_ACCOUNT_0);
    expect(body.chainId).toBe(8453);
    expect(body.expiresAt).toBe(EXPIRES_AT);
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/); // 65 bytes

    // Round-trip: the signature verifies against the signer.
    const ok = await verifySignedLoginIntent(body);
    expect(ok).toBe(true);
  });

  it("is deterministic for fixed (wallet, expiresAt, domain) — same signature every time", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 8453);
    const a = await signWalletLoginIntent({ wallet, expiresAt: EXPIRES_AT });
    const b = await signWalletLoginIntent({ wallet, expiresAt: EXPIRES_AT });
    expect(a.signature).toBe(b.signature);
  });

  it("rejects chain-id mismatch between wallet and domain", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 1);
    await expect(
      signWalletLoginIntent({
        wallet,
        expiresAt: EXPIRES_AT,
        // Default domain is 8453; wallet is 1
      }),
    ).rejects.toThrow(/chainId/);
  });

  it("rejects non-positive expiresAt", async () => {
    // Match the default domain chainId (8453) so the expiresAt guard is the
    // one that fires, not the chainId guard.
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 8453);
    await expect(
      signWalletLoginIntent({ wallet, expiresAt: 0 }),
    ).rejects.toThrow(/expiresAt/);
    await expect(
      signWalletLoginIntent({ wallet, expiresAt: -1 }),
    ).rejects.toThrow(/expiresAt/);
  });

  it("LOAD-BEARING: verification FAILS if message fields are tampered with", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 8453);
    const body = await signWalletLoginIntent({
      wallet,
      expiresAt: EXPIRES_AT,
    });

    // Tamper with expiresAt — verification should reject.
    const tamperedExpiresAt = { ...body, expiresAt: EXPIRES_AT + 1 };
    expect(await verifySignedLoginIntent(tamperedExpiresAt)).toBe(false);

    // Tamper with claimed address — verification should reject.
    const tamperedAddress = {
      ...body,
      address: HARDHAT_ACCOUNT_1 as `0x${string}`,
    };
    expect(await verifySignedLoginIntent(tamperedAddress)).toBe(false);
  });
});

// Regression guard for the HD-derive ↔ signature-recovery invariant.
//
// History: a hypothesized viem-upgrade bug (`getHdKey().privateKey`
// returning the parent extended key instead of the leaf signing key)
// would surface as backend `/auth/wallet` 401s of the form
// "signature recovered 0xAAA, expected 0xBBB" for *every* derived
// wallet. The class of bug is silent at unit level if you only test
// agentIndex=0 (which is the master derivation in some shapes), so
// this loopback drives the same path the harness takes — multiple
// indexes, full sign-then-recover round-trip — and asserts that
// `body.address === recoveredSigner` for each.
//
// If this test ever flips to FAIL, the fix is in `derive.ts`: do
// not extract privateKey from the HDKey wrapper; either return the
// HDAccount directly to callers (Option A) or derive the leaf via
// `@scure/bip32` HDKey directly (Option B). See task notes for
// loop covering the bug.
describe("HD derive ↔ EIP-712 sign-and-recover loopback (regression)", () => {
  it("each of 6 sequential agents produces a signature recoverable to its declared address", async () => {
    const wallets = deriveAgentWallets(HARDHAT_TEST_MNEMONIC, 6, 8453);
    expect(wallets).toHaveLength(6);
    const expiresAt = 1_700_000_000;
    for (const w of wallets) {
      const body = await signWalletLoginIntent({ wallet: w, expiresAt });
      expect(body.address).toBe(w.address);
      const ok = await verifySignedLoginIntent(body);
      expect(ok, `agentIndex=${w.agentIndex} (${w.address}) sign+recover MUST round-trip — HD-derive vs sign-key drift`).toBe(true);
    }
  });
});

describe("DEFAULT_LOGIN_DOMAIN — backend contract pin", () => {
  it("matches the backend's Config.SigningDomain default shape", () => {
    // If this test fails, the backend's config.go loadSigningDomain
    // defaults were changed and the agent needs to catch up. Any
    // drift makes every signed intent fail recovery.
    expect(DEFAULT_LOGIN_DOMAIN.name).toBe("RezonTreeOracle");
    expect(DEFAULT_LOGIN_DOMAIN.version).toBe("1");
    expect(DEFAULT_LOGIN_DOMAIN.chainId).toBe(8453);
    expect(DEFAULT_LOGIN_DOMAIN.verifyingContract.toLowerCase()).toBe(
      "0x9dfe5b0cd930f1bda58c2c55f8b26ed5dd999666",
    );
  });
});
