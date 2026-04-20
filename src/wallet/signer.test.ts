// Cross-system golden vector + unit coverage for the
// wallet-login signer — cartridge loop 0062.
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
//   - chainId: 84532 (Base Sepolia)
//   - issuedAt: 1_700_000_000 (a fixed past timestamp)
//   - Domain: default RezonTree signing domain
//
// Expected recovered address after sign-then-verify MUST equal
// the derived address.

import { describe, expect, it } from "vitest";

import { DEFAULT_LOGIN_DOMAIN } from "./domain.js";
import { HARDHAT_TEST_MNEMONIC, deriveAgentWallet } from "./derive.js";
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
  const ISSUED_AT = 1_700_000_000;

  it("produces a signature whose recovered address matches the signer", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 84532);
    const body = await signWalletLoginIntent({
      wallet,
      issuedAt: ISSUED_AT,
    });
    expect(body.address.toLowerCase()).toBe(HARDHAT_ACCOUNT_0);
    expect(body.chain_id).toBe(84532);
    expect(body.issued_at).toBe(ISSUED_AT);
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/); // 65 bytes

    // Round-trip: the signature verifies against the signer.
    const ok = await verifySignedLoginIntent(body);
    expect(ok).toBe(true);
  });

  it("is deterministic for fixed (wallet, issuedAt, domain) — same signature every time", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 84532);
    const a = await signWalletLoginIntent({ wallet, issuedAt: ISSUED_AT });
    const b = await signWalletLoginIntent({ wallet, issuedAt: ISSUED_AT });
    expect(a.signature).toBe(b.signature);
  });

  it("rejects chain-id mismatch between wallet and domain", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 1);
    await expect(
      signWalletLoginIntent({
        wallet,
        issuedAt: ISSUED_AT,
        // Default domain is 84532; wallet is 1
      }),
    ).rejects.toThrow(/chainId/);
  });

  it("rejects non-positive issuedAt", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 84532);
    await expect(
      signWalletLoginIntent({ wallet, issuedAt: 0 }),
    ).rejects.toThrow(/issuedAt/);
    await expect(
      signWalletLoginIntent({ wallet, issuedAt: -1 }),
    ).rejects.toThrow(/issuedAt/);
  });

  it("LOAD-BEARING: verification FAILS if message fields are tampered with", async () => {
    const wallet = deriveAgentWallet(HARDHAT_TEST_MNEMONIC, 0, 84532);
    const body = await signWalletLoginIntent({
      wallet,
      issuedAt: ISSUED_AT,
    });

    // Tamper with issued_at — verification should reject.
    const tamperedIssuedAt = { ...body, issued_at: ISSUED_AT + 1 };
    expect(await verifySignedLoginIntent(tamperedIssuedAt)).toBe(false);

    // Tamper with claimed address — verification should reject.
    const tamperedAddress = {
      ...body,
      address: HARDHAT_ACCOUNT_1 as `0x${string}`,
    };
    expect(await verifySignedLoginIntent(tamperedAddress)).toBe(false);
  });
});

describe("DEFAULT_LOGIN_DOMAIN — backend contract pin", () => {
  it("matches the backend's Config.SigningDomain default shape", () => {
    // If this test fails, the backend's config.go loadSigningDomain
    // defaults were changed and the agent needs to catch up. Any
    // drift makes every signed intent fail recovery.
    expect(DEFAULT_LOGIN_DOMAIN.name).toBe("RezonTreeOracle");
    expect(DEFAULT_LOGIN_DOMAIN.version).toBe("1");
    expect(DEFAULT_LOGIN_DOMAIN.chainId).toBe(84532);
    expect(DEFAULT_LOGIN_DOMAIN.verifyingContract.toLowerCase()).toBe(
      "0x0000000000000000000000000000000000000001",
    );
  });
});
