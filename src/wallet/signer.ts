// WalletLoginIntent signer — cartridge loop 0062.
//
// Signs the EIP-712 payload the backend's /auth/wallet expects.
// Backend recovers the signer's address and compares to the
// `address` field of the POST body; if they don't match, 401.
//
// Field order, types, and domain MUST match
// internal/signer/wallet_login_intent.go (backend) byte-for-byte.
// A mismatch typically surfaces on the backend as
// `AGENT_NOT_FOUND` because the recovered address is gibberish
// and doesn't exist in the agents table. Golden-vector test
// (`signer.test.ts`) pins the shape.

import {
  type Address,
  type Hex,
  type TypedDataDomain,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  type LoginDomain,
  DEFAULT_LOGIN_DOMAIN,
  WALLET_LOGIN_INTENT_TYPES,
} from "./domain.js";
import type {
  AgentWallet,
  SignedWalletLoginIntent,
  WalletLoginIntent,
} from "./types.js";

export interface SignLoginInput {
  wallet: AgentWallet;
  /** Unix seconds. Backend enforces ±5 min freshness window;
   *  caller should use Math.floor(Date.now()/1000) immediately
   *  before sign. */
  expiresAt: number;
  /** Defaults to DEFAULT_LOGIN_DOMAIN; override only for tests
   *  or operators using a custom SIGNING_DOMAIN_* env set. */
  domain?: LoginDomain;
}

function toViemDomain(d: LoginDomain): TypedDataDomain {
  return {
    name: d.name,
    version: d.version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

/**
 * signWalletLoginIntent returns the POST body shape for
 * `POST /auth/wallet`. Throws if the wallet's declared chainId
 * doesn't match the signing domain's (fail-fast; backend would
 * reject with a less-specific error).
 */
export async function signWalletLoginIntent(
  input: SignLoginInput,
): Promise<SignedWalletLoginIntent> {
  const domain = input.domain ?? DEFAULT_LOGIN_DOMAIN;
  if (input.wallet.chainId !== domain.chainId) {
    throw new Error(
      `wallet chainId ${input.wallet.chainId} does not match domain chainId ${domain.chainId} — signature would be rejected by backend`,
    );
  }
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error(
      `expiresAt must be a positive integer unix-seconds, got ${input.expiresAt}`,
    );
  }

  const account = privateKeyToAccount(input.wallet.privateKey);
  const message: WalletLoginIntent = {
    ethAddress: input.wallet.address,
    chainId: BigInt(domain.chainId),
    expiresAt: BigInt(input.expiresAt),
  };

  const signature = await account.signTypedData({
    domain: toViemDomain(domain),
    types: WALLET_LOGIN_INTENT_TYPES,
    primaryType: "WalletLoginIntent",
    message,
  });

  return {
    address: input.wallet.address,
    chainId: domain.chainId,
    expiresAt: input.expiresAt,
    signature,
  };
}

/**
 * verifySignedLoginIntent — same-process sanity check.
 * Recovers the signer from `body.signature` using `body.address`
 * as the expected recoverer. Returns `true` iff the recovered
 * address matches. Useful in tests + for fail-fast validation
 * before POSTing to the backend.
 */
export async function verifySignedLoginIntent(
  body: SignedWalletLoginIntent,
  domain: LoginDomain = DEFAULT_LOGIN_DOMAIN,
): Promise<boolean> {
  if (body.chainId !== domain.chainId) return false;
  const message: WalletLoginIntent = {
    ethAddress: body.address as Address,
    chainId: BigInt(body.chainId),
    expiresAt: BigInt(body.expiresAt),
  };
  return verifyTypedData({
    address: body.address as Address,
    domain: toViemDomain(domain),
    types: WALLET_LOGIN_INTENT_TYPES,
    primaryType: "WalletLoginIntent",
    message,
    signature: body.signature as Hex,
  });
}
