// envelope.ts — Quadphase v2 unified envelope EIP-712 typed-data.
//
// Every chain-bound action (Sponsor/Cosponsor/Commit/Vote/Settle/
// Claim/Refund/Abandon) signs the same Envelope shape; the per-action
// payload lives in the witness, and only its keccak hash sits on the
// envelope (env.contentHash). This file is the SDK-side mirror of
// internal/protocol/quadphase.go::Envelope + Funds + FeeShare and of
// contracts/src/QuadphaseTypes.sol's QuadphaseTypehashes library.
//
// Three drift fences:
//   1. internal/signer/typehash_drift_test.go pins the Go-side typestring
//      to the Solidity library byte-for-byte.
//   2. internal/signer/polyglot_drift_test.go::TestPolyglot_UIAndSDK_
//      QuadphaseV2TypedDataArrays asserts this file's ENVELOPE_TYPES
//      arity (Envelope=7, Funds=8, FeeShare=2) matches the UI mirror.
//   3. testdata/envelope-vectors.json (mirrored from the Go golden test)
//      pins TS-computed expectedIntentHash for the 8 actions.
//
// R-CHAIN-VERIFIES-INTENT — the chain re-derives env.contentHash from
// witness bytes at Stage-4; mismatches reject the row.
// R-CLIENT-IS-TRUST-ORIGIN — the client builds the envelope from
// preflight-advertised params; the server never authors signed bytes.

import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

import {
  buildForgeDomain,
  type ForgeIntentDomain,
} from "./forge-domain.js";

// ─────────────────────────────────────────────────────────────────────
// EIP-712 type arrays
// ─────────────────────────────────────────────────────────────────────
//
// EIP-712 v4 requires referenced struct types appear AFTER the primary
// type, sub-struct ordering MUST be alphabetical (FeeShare before
// Funds). Drift here produces signatures the chain rejects on every
// submit — fenced by polyglot_drift_test.

export const ENVELOPE_TYPES = {
  Envelope: [
    { name: "signer", type: "address" },
    { name: "qid", type: "bytes32" },
    { name: "action", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "contentHash", type: "bytes32" },
    { name: "funds", type: "Funds" },
  ],
  FeeShare: [
    { name: "recipient", type: "address" },
    { name: "basisPoints", type: "uint16" },
  ],
  Funds: [
    { name: "token", type: "address" },
    { name: "poolIn", type: "uint256" },
    { name: "poolOut", type: "uint256" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeShareBps", type: "uint16" },
    { name: "feeShares", type: "FeeShare[]" },
    { name: "stakeAmount", type: "uint256" },
    { name: "stakeOp", type: "uint8" },
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────
// Action tag enum — pinned cross-stack with Solidity QuadphaseTypes
// and internal/protocol/quadphase.go::ActionTag.
// ─────────────────────────────────────────────────────────────────────

export enum ActionTag {
  Sponsor = 0,
  Cosponsor = 1,
  Commit = 2,
  Vote = 3,
  Settle = 4,
  Claim = 5,
  Refund = 6,
  Abandon = 7,
}

export enum StakeOp {
  None = 0,
  Lock = 1,
  Release = 2,
}

// ─────────────────────────────────────────────────────────────────────
// Wire shapes
// ─────────────────────────────────────────────────────────────────────

export interface FeeShare {
  recipient: Address;
  basisPoints: number;
}

export interface Funds {
  token: Address;
  poolIn: bigint;
  poolOut: bigint;
  feeAmount: bigint;
  feeShareBps: number;
  feeShares: FeeShare[];
  stakeAmount: bigint;
  stakeOp: StakeOp;
}

export interface Envelope {
  signer: Address;
  qid: Hex;
  action: ActionTag;
  nonce: bigint;
  expiresAt: bigint;
  contentHash: Hex;
  funds: Funds;
}

// ─────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────

/**
 * Builds the typed-data tuple for viem's `signTypedData` from an
 * envelope + domain. The returned object is passed directly to a
 * walletClient.signTypedData call.
 *
 * R-CLIENT-IS-TRUST-ORIGIN: envelope fields come from preflight's
 * `envelopeTemplate` so the chain-domain stays in lockstep.
 */
export function buildEnvelopeTypedData(params: {
  envelope: Envelope;
  domain: ForgeIntentDomain;
}): {
  domain: ForgeIntentDomain;
  types: typeof ENVELOPE_TYPES;
  primaryType: "Envelope";
  message: Envelope;
} {
  return {
    domain: params.domain,
    types: ENVELOPE_TYPES,
    primaryType: "Envelope",
    message: params.envelope,
  };
}

/**
 * Convenience: builds the domain from chain-id + forge address and
 * returns the typed-data ready to sign.
 */
export function buildEnvelopeForSigning(params: {
  envelope: Envelope;
  chainId: number | bigint;
  forgeAddress: Address;
}) {
  return buildEnvelopeTypedData({
    envelope: params.envelope,
    domain: buildForgeDomain({
      chainId: params.chainId,
      forgeAddress: params.forgeAddress,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Hashing primitives — for testdata golden vector verification and for
// the rare client that needs to recompute intentHash before broadcast.
// ─────────────────────────────────────────────────────────────────────

const ENVELOPE_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Envelope(address signer,bytes32 qid,uint8 action,uint256 nonce,uint256 expiresAt,bytes32 contentHash,Funds funds)" +
      "FeeShare(address recipient,uint16 basisPoints)" +
      "Funds(address token,uint256 poolIn,uint256 poolOut,uint256 feeAmount,uint16 feeShareBps,FeeShare[] feeShares,uint256 stakeAmount,uint8 stakeOp)",
  ),
);

const FUNDS_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Funds(address token,uint256 poolIn,uint256 poolOut,uint256 feeAmount,uint16 feeShareBps,FeeShare[] feeShares,uint256 stakeAmount,uint8 stakeOp)" +
      "FeeShare(address recipient,uint16 basisPoints)",
  ),
);

const FEE_SHARE_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "FeeShare(address recipient,uint16 basisPoints)",
  ),
);

function hashFeeShare(fs: FeeShare): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, address, uint16"),
      [FEE_SHARE_TYPEHASH, fs.recipient, fs.basisPoints],
    ),
  );
}

function hashFeeShares(shares: FeeShare[]): Hex {
  const concat: Hex = ("0x" +
    shares.map((s) => hashFeeShare(s).slice(2)).join("")) as Hex;
  return keccak256(concat);
}

function hashFunds(f: Funds): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, address, uint256, uint256, uint256, uint16, bytes32, uint256, uint8",
      ),
      [
        FUNDS_TYPEHASH,
        f.token,
        f.poolIn,
        f.poolOut,
        f.feeAmount,
        f.feeShareBps,
        hashFeeShares(f.feeShares),
        f.stakeAmount,
        f.stakeOp,
      ],
    ),
  );
}

/**
 * Recomputes the EIP-712 struct hash of an Envelope. Result is the
 * inner hash before the 0x1901 || domainSeparator prefix; combine with
 * the domain separator to produce the intentHash the chain emits.
 */
export function hashEnvelopeStruct(env: Envelope): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, address, bytes32, uint8, uint256, uint256, bytes32, bytes32",
      ),
      [
        ENVELOPE_TYPEHASH,
        env.signer,
        env.qid,
        env.action,
        env.nonce,
        env.expiresAt,
        env.contentHash,
        hashFunds(env.funds),
      ],
    ),
  );
}
