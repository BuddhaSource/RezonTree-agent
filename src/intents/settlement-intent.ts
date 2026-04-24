// settlement-intent.ts — oracle-signed SettlementIntent builder.
//
// Loop 0079: operator-path settlement. The ORACLE_ENABLED keeper
// is production v1+ work (needs Gnosis Safe quorum). For v0 prod,
// a script runs this builder to sign + publish a Merkle-root
// settlement via the oracle private key.
//
// EIP-712 typehash (must match contracts/src/Router.sol:96):
//   "SettlementIntent(bytes32 questionId,bytes32 merkleRoot,uint256 expiresAt)"
//
// The oracle signer is set in Router's constructor. On Base Sepolia
// Router 0x0BB8e006…, that's 0x55Bd1aAE… (operator mnemonic path 0).

import type { Address, Hex, TypedDataDomain } from "viem";
import { buildRouterDomain } from "./router-domain.js";

/** EIP-712 types for SettlementIntent. Field order fixed by the
 *  Router's typehash; a reorder breaks on-chain signature recovery. */
export const SETTLEMENT_INTENT_TYPES = {
  SettlementIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "merkleRoot", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "slashedCommitHashes", type: "bytes32[]" },
    { name: "slashedVoteHashes", type: "bytes32[]" },
  ],
} as const;

/** Default TTL for a settlement envelope. 30 minutes gives the
 *  operator room to sign offline + broadcast; Router rejects on
 *  expiresAt <= block.timestamp. */
export const DEFAULT_SETTLEMENT_TTL_SECONDS = 30 * 60;

export interface SettlementIntentMessage {
  questionId: Hex;
  merkleRoot: Hex;
  expiresAt: bigint;
  slashedCommitHashes: Hex[];
  slashedVoteHashes: Hex[];
}

export interface BuildSettlementIntentInput {
  routerAddress: Address;
  chainId: number;
  questionId: Hex;
  merkleRoot: Hex;
  /** Intent hashes of losing commits — bonds slashed into pool at
   *  settlement time. Empty for rounds with no losers. */
  slashedCommitHashes?: Hex[];
  /** Intent hashes of wrong-voter intents — bonds slashed. */
  slashedVoteHashes?: Hex[];
  /** Unix seconds. Defaults to now + 30min. */
  expiresAtSeconds?: number;
  /** Wall-clock seconds (test injection). Defaults to Math.floor(Date.now()/1000). */
  nowSeconds?: number;
}

export interface SettlementTypedData {
  domain: TypedDataDomain;
  types: typeof SETTLEMENT_INTENT_TYPES;
  primaryType: "SettlementIntent";
  message: SettlementIntentMessage;
}

/** Build the EIP-712 typed data for signTypedData. The oracle
 *  signs this; Router recovers to `oracle` on publishSettlement. */
export function buildSettlementIntentTypedData(
  input: BuildSettlementIntentInput,
): SettlementTypedData {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = BigInt(input.expiresAtSeconds ?? now + DEFAULT_SETTLEMENT_TTL_SECONDS);

  return {
    domain: buildRouterDomain({
      chainId: input.chainId,
      routerAddress: input.routerAddress,
    }),
    types: SETTLEMENT_INTENT_TYPES,
    primaryType: "SettlementIntent",
    message: {
      questionId: input.questionId,
      merkleRoot: input.merkleRoot,
      expiresAt,
      slashedCommitHashes: input.slashedCommitHashes ?? [],
      slashedVoteHashes: input.slashedVoteHashes ?? [],
    },
  };
}
