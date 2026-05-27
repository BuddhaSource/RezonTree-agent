// withdraw-fees.ts — RezonForge.withdrawFees(recipient, token) helper.
//
// The fee-model payout rail (economics.md §0.2, requirement P6). Accrued
// platform + referral fees accumulate in the contract's
// `accruedFees[recipient][token]` mapping across ALL questions; a recipient
// (or a sweeper acting on their behalf) drains the whole tab in one call.
//
//   withdrawFees(address recipient, address tk)
//
// PERMISSIONLESS CALLER — anyone may invoke it, but the funds ALWAYS go to
// `recipient` (the balance-lookup key, the transfer destination, AND the
// event subject). `msg.sender` never receives or redirects funds, so there
// is no theft surface. This is the intended sweeper pattern: a hot operator
// wallet pays gas to deliver fees to cold platform/referrer wallets that
// hold no ETH and never sign. (contracts/src/RezonForge.sol::withdrawFees.)
//
// No EIP-712 intent / signature — withdrawFees is a plain state-changing
// call, NOT a Quadphase signed-intent action (it moves already-accrued,
// already-attributed funds to their rightful owner). It therefore lives
// outside the envelope broadcast surface in quadphase-broadcast.ts.

import {
  type Account,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";

// Self-contained ABI fragment — the only fee-withdrawal surface the SDK
// broadcasts to. Mirrors RezonTree-UI's copy (added in fee-model B4) +
// the contract signature `withdrawFees(address recipient, address tk)`.
export const WITHDRAW_FEES_ABI = [
  {
    type: "function",
    name: "withdrawFees",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "tk", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
] as const;

export interface WithdrawFeesParams {
  forgeAddress: Address;
  /** The accrued-fee balance owner. Funds are sent HERE regardless of who
   *  broadcasts (the caller can be a gas-paying sweeper). */
  recipient: Address;
  /** ERC-20 token whose accrued balance to drain (the question's bounty
   *  token; accrual is per-token). */
  token: Address;
  /** Optional gas override for flaky estimators. */
  gas?: bigint;
}

/**
 * Broadcasts `withdrawFees(recipient, token)`. The signing wallet
 * (`wallet.account`) pays gas; the accrued funds settle to `recipient`.
 * Reverts `withdraw:nothing-accrued` when the balance is zero — callers
 * (e.g. the sweeper) should gate on a positive balance first to avoid
 * burning gas on an empty tab.
 */
export async function broadcastWithdrawFees(
  wallet: WalletClient,
  params: WithdrawFeesParams,
): Promise<Hex> {
  return wallet.writeContract({
    address: params.forgeAddress,
    abi: WITHDRAW_FEES_ABI,
    functionName: "withdrawFees",
    args: [params.recipient, params.token],
    account: wallet.account as Account,
    chain: wallet.chain,
    ...(params.gas ? { gas: params.gas } : {}),
  });
}
