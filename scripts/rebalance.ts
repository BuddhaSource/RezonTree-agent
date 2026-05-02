#!/usr/bin/env tsx
// rebalance.ts — F-NEW-6 sponsor-drain rebalancer.
//
// Battle conservation moves USDC sponsor → solver every scenario.
// Alice (sponsor) drains; bob (solver-winner) accumulates. Without
// rebalancing, a long battle eventually ENG-fails when alice can't
// satisfy `sponsorship_floor`.
//
// Strategy (auto-detect):
//   • Read alice's USDC balance.
//   • If alice < MIN_SPONSOR_BUFFER_USDC, transfer
//     SPONSOR_REFILL_USDC from bob if bob has enough; otherwise from
//     operator.
//   • Log the decision (which source, how much, why).
//
// Invoked by run-battle.ts every N scenarios so a 50-question battle
// doesn't drain mid-run.
//
// CLI: `tsx scripts/rebalance.ts [--dry]` — dry-run prints the
// decision without sending any tx.

import { mnemonicToAccount } from "viem/accounts";
import {
  type Address,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  parseUnits,
} from "viem";
import { baseSepolia } from "viem/chains";

import {
  makeFallbackTransport,
  resolveRpcUrls,
} from "../src/testnet/rpc-fallback.js";

const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const USDC = (process.env.RT_USDC_ADDRESS as Address) ??
  ("0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const);

// USDC has 6 decimals on Base Sepolia.
const DECIMALS = 6;
// Buffer floor: if alice < this, we top her up.
const MIN_SPONSOR_BUFFER_USDC = parseUnits(
  process.env.MIN_SPONSOR_BUFFER_USDC ?? "10",
  DECIMALS,
);
// Refill amount: each top-up moves this much.
const SPONSOR_REFILL_USDC = parseUnits(
  process.env.SPONSOR_REFILL_USDC ?? "20",
  DECIMALS,
);
// Source-low threshold: bob (or operator) must hold at least this
// much before we drain from them.
const SOURCE_MIN_USDC = parseUnits(
  process.env.SOURCE_MIN_USDC ?? "30",
  DECIMALS,
);

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const operator = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const alice = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const bob = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });

const transport = makeFallbackTransport(resolveRpcUrls(process.env));
const publicClient = createPublicClient({ chain: baseSepolia, transport });

function fmt(amount: bigint): string {
  return formatUnits(amount, DECIMALS);
}

async function getBalance(addr: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
}

interface RebalanceDecision {
  needed: boolean;
  source?: "bob" | "operator";
  amount?: bigint;
  reason: string;
}

export async function planRebalance(): Promise<RebalanceDecision> {
  const aliceBal = await getBalance(alice.address);
  if (aliceBal >= MIN_SPONSOR_BUFFER_USDC) {
    return {
      needed: false,
      reason: `alice ${fmt(aliceBal)} USDC >= floor ${fmt(MIN_SPONSOR_BUFFER_USDC)}`,
    };
  }
  const bobBal = await getBalance(bob.address);
  if (bobBal >= SOURCE_MIN_USDC + SPONSOR_REFILL_USDC) {
    return {
      needed: true,
      source: "bob",
      amount: SPONSOR_REFILL_USDC,
      reason: `alice ${fmt(aliceBal)} USDC < floor; bob has ${fmt(bobBal)} (>= source-min ${fmt(SOURCE_MIN_USDC)} + refill ${fmt(SPONSOR_REFILL_USDC)})`,
    };
  }
  const opBal = await getBalance(operator.address);
  if (opBal >= SPONSOR_REFILL_USDC) {
    return {
      needed: true,
      source: "operator",
      amount: SPONSOR_REFILL_USDC,
      reason: `alice ${fmt(aliceBal)} USDC < floor; bob ${fmt(bobBal)} below source-min; operator has ${fmt(opBal)}`,
    };
  }
  return {
    needed: true,
    reason: `alice ${fmt(aliceBal)} < floor but no source has enough (bob ${fmt(bobBal)}, operator ${fmt(opBal)})`,
  };
}

async function transferUsdc(
  wallet: WalletClient,
  to: Address,
  amount: bigint,
): Promise<void> {
  const account = wallet.account;
  if (!account) throw new Error("walletClient missing account");
  const hash = await wallet.sendTransaction({
    account,
    chain: baseSepolia,
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amount],
    }),
  });
  console.log(`  tx ${hash}`);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  status: ${r.status}`);
  if (r.status !== "success") {
    throw new Error(`transfer reverted: tx ${hash}`);
  }
}

export async function rebalance(opts: { dryRun?: boolean } = {}): Promise<RebalanceDecision> {
  const decision = await planRebalance();
  if (!decision.needed) {
    console.log(`[rebalance] skip: ${decision.reason}`);
    return decision;
  }
  if (!decision.source || !decision.amount) {
    console.warn(`[rebalance] WARN: ${decision.reason}`);
    return decision;
  }
  console.log(
    `[rebalance] ${decision.source} → alice +${fmt(decision.amount)} USDC (${decision.reason})`,
  );
  if (opts.dryRun) {
    console.log("[rebalance] dry-run; no tx sent");
    return decision;
  }
  const sourceAccount =
    decision.source === "bob" ? bob : operator;
  const wallet = createWalletClient({
    account: sourceAccount,
    chain: baseSepolia,
    transport,
  });
  await transferUsdc(wallet, alice.address, decision.amount);
  return decision;
}

// CLI entry — only runs when invoked directly, not when imported by
// run-battle.ts.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dry = process.argv.includes("--dry");
  rebalance({ dryRun: dry })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[rebalance] FAIL: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}
