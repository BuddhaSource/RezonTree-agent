#!/usr/bin/env tsx
// sweep-fees.ts — drains accrued platform + referral fees to their owners.
//
// The fee-model payout rail (economics.md §0.2 / requirement P6). The
// realized-outcome fee skimmed at each settlement is credited to the
// contract's GLOBAL `accruedFees[recipient][token]` mapping — one tab per
// (recipient, token), accumulating across ALL questions. Recipients
// (platform, referrers) withdraw once via `withdrawFees(recipient, token)`,
// which is PERMISSIONLESS: the funds always go to `recipient`, never the
// caller. So this sweeper — running on a gas-paying operator wallet — can
// deliver fees to COLD platform/referrer wallets that hold no ETH and never
// sign. Zero theft surface (the destination is the balance-lookup key, not
// msg.sender; see contracts/src/RezonForge.sol::withdrawFees).
//
// THRESHOLD-GATED. Referral cuts are often cents; a withdrawal costs gas.
// We only sweep a (recipient, token) tab whose accrued balance clears
// RT_FEE_SWEEP_MIN_BASEUNITS (default 1 USDC = 1_000_000 base units). Dust
// stays put until it grows — never swept uneconomically.
//
// DATA SOURCE. We read the authoritative balance from the on-chain
// `accruedFees(recipient, token)` public getter (already net of past
// withdrawals — it's the exact value withdrawFees would transfer). The
// backend's `GET /v1/accounts/:addr?include=fee_earnings` (fee-model B4)
// surfaces the same number with token metadata for dashboards/discovery;
// the on-chain read needs no auth and works for cold wallets, so the
// sweeper uses it directly.
//
// RECIPIENT SET. Three sources, union'd + de-duped:
//   1. --recipients=0xAddr,0xAddr   (explicit; platform + known referrers)
//   2. RT_FEE_SWEEP_RECIPIENTS env  (comma-separated; same shape)
//   3. RT_PLATFORM_FEE_RECIPIENT    (the platform fee address — always swept)
// (Per-referrer discovery from FeesWithdrawn/feeDistributions projections is
//  a backend concern; pass the address set you want delivered.)
//
// TOKEN SET. --tokens=0xAddr,...  or RT_FEE_SWEEP_TOKENS (comma-separated).
// Defaults to RT_USDC_ADDRESS (the only bounty token in this deployment).
//
// Usage:
//   pnpm tsx scripts/sweep-fees.ts                       # dry-run (default)
//   pnpm tsx scripts/sweep-fees.ts --execute             # broadcast
//   pnpm tsx scripts/sweep-fees.ts \
//     --recipients=0xPlatform,0xReferrer --tokens=0xUSDC --execute
//   RT_FEE_SWEEP_MIN_BASEUNITS=5000000 pnpm tsx scripts/sweep-fees.ts  # 5 USDC floor
//
// Operator wallet (mnemonic idx 0) pays gas for every withdrawal; funds
// land in each recipient's own wallet.

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  isAddress,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";

import {
  WITHDRAW_FEES_ABI,
  broadcastWithdrawFees,
} from "../src/forge/withdraw-fees.js";

const FORGE = (process.env.RT_FORGE_ADDRESS ??
  "0x89E8D5b1ABE6531577Aaf2611CF66fa01094e8F1") as Address;
const RPCS = (process.env.RT_RPC_URLS ?? process.env.RT_RPC_URL ?? "https://sepolia.base.org")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const M = process.env.RT_AGENT_MNEMONIC;
const CHAIN_ID = Number(process.env.RT_CHAIN_ID ?? "84532");
// 1 USDC (6 decimals) — withdrawing a smaller tab usually costs more in gas
// than it delivers. Tune per token decimals / gas price.
const MIN_BASEUNITS = BigInt(process.env.RT_FEE_SWEEP_MIN_BASEUNITS ?? "1000000");

if (!M) {
  console.error("RT_AGENT_MNEMONIC required (operator pays gas for withdrawals)");
  process.exit(2);
}

// accruedFees(recipient, token) — the public mapping getter. The exact
// balance withdrawFees would transfer (net of prior withdrawals).
const ACCRUED_FEES_ABI = [
  {
    type: "function",
    name: "accruedFees",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function flag(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  return hit ? hit.slice(pfx.length) : undefined;
}

function parseAddrList(raw: string | undefined): Address[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!isAddress(s)) throw new Error(`not an address: ${s}`);
      return getAddress(s) as Address;
    });
}

function fmtBase(amount: bigint, decimals = 6): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

async function main() {
  const execute = process.argv.includes("--execute");

  // ── Recipient set (union of explicit + env + platform). ──
  const recipientSet = new Map<string, Address>();
  for (const a of parseAddrList(flag("recipients") ?? process.env.RT_FEE_SWEEP_RECIPIENTS)) {
    recipientSet.set(a.toLowerCase(), a);
  }
  const platform = process.env.RT_PLATFORM_FEE_RECIPIENT;
  if (platform && isAddress(platform)) {
    const p = getAddress(platform) as Address;
    recipientSet.set(p.toLowerCase(), p);
  }
  const recipients = [...recipientSet.values()];

  // ── Token set (explicit + env, default USDC). ──
  let tokens = parseAddrList(flag("tokens") ?? process.env.RT_FEE_SWEEP_TOKENS);
  if (tokens.length === 0) {
    const usdc = process.env.RT_USDC_ADDRESS;
    if (usdc && isAddress(usdc)) tokens = [getAddress(usdc) as Address];
  }

  const operatorAccount = mnemonicToAccount(M as string, { addressIndex: 0 });
  const pub = createPublicClient({
    chain: baseSepolia,
    transport: fallback(RPCS.map((url) => http(url, { batch: { batchSize: 100 } }))),
  });

  console.log(`Operator:  ${operatorAccount.address} (idx 0, pays gas)`);
  console.log(`Forge:     ${FORGE}`);
  console.log(`Threshold: ${fmtBase(MIN_BASEUNITS)} base units (RT_FEE_SWEEP_MIN_BASEUNITS=${MIN_BASEUNITS})`);
  console.log(`Recipients: ${recipients.length}  Tokens: ${tokens.length}`);
  console.log(`Mode:      ${execute ? "EXECUTE — will broadcast" : "DRY-RUN (use --execute to broadcast)"}`);
  console.log("");

  if (recipients.length === 0) {
    console.error("No recipients. Pass --recipients=0x..,0x.. or set RT_FEE_SWEEP_RECIPIENTS / RT_PLATFORM_FEE_RECIPIENT.");
    process.exit(2);
  }
  if (tokens.length === 0) {
    console.error("No tokens. Pass --tokens=0x.. or set RT_FEE_SWEEP_TOKENS / RT_USDC_ADDRESS.");
    process.exit(2);
  }

  // ── Read every (recipient, token) accrued balance; classify. ──
  interface Tab { recipient: Address; token: Address; accrued: bigint }
  const sweepable: Tab[] = [];
  let belowThreshold = 0;
  let empty = 0;

  for (const recipient of recipients) {
    for (const token of tokens) {
      let accrued = 0n;
      try {
        accrued = (await pub.readContract({
          address: FORGE,
          abi: ACCRUED_FEES_ABI,
          functionName: "accruedFees",
          args: [recipient, token],
        })) as bigint;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  accruedFees read failed (${recipient}/${token}): ${msg.split("\n")[0]}`);
        continue;
      }
      if (accrued === 0n) {
        empty++;
        continue;
      }
      if (accrued < MIN_BASEUNITS) {
        belowThreshold++;
        console.log(`  skip ${recipient} ${fmtBase(accrued)} < threshold (token ${token.slice(0, 10)}…)`);
        continue;
      }
      sweepable.push({ recipient, token, accrued });
    }
  }

  console.log("");
  console.log(`  sweepable:        ${sweepable.length}`);
  console.log(`  below-threshold:  ${belowThreshold}`);
  console.log(`  empty:            ${empty}`);
  console.log("");

  if (sweepable.length === 0) {
    console.log("Nothing to sweep.");
    return;
  }

  const opWallet = createWalletClient({
    chain: baseSepolia,
    transport: fallback(RPCS.map((url) => http(url))),
    account: operatorAccount,
  });

  let swept = 0n;
  let ok = 0;
  let failed = 0;
  for (const t of sweepable) {
    if (!execute) {
      console.log(`  DRY withdrawFees(${t.recipient}, ${t.token.slice(0, 10)}…) → ${fmtBase(t.accrued)}`);
      continue;
    }
    try {
      const tx = await broadcastWithdrawFees(opWallet, {
        forgeAddress: FORGE,
        recipient: t.recipient,
        token: t.token,
      });
      await pub.waitForTransactionReceipt({ hash: tx as Hex, timeout: 60_000 });
      console.log(`  ✓ withdrawFees(${t.recipient}) ${fmtBase(t.accrued)} tx=${tx}`);
      swept += t.accrued;
      ok++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // A concurrent sweep / self-withdraw may have drained the tab first
      // (withdraw:nothing-accrued) — harmless, the owner already has it.
      console.log(`  ✗ withdrawFees(${t.recipient}) ${msg.split("\n")[0].slice(0, 160)}`);
      failed++;
    }
  }

  console.log("");
  if (execute) {
    console.log(`Done. swept=${fmtBase(swept)} across ${ok} tab(s); ${failed} failed.`);
  } else {
    console.log(`Dry-run complete. ${sweepable.length} tab(s) would be swept (use --execute).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
