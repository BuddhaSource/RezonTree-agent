#!/usr/bin/env tsx
// scripts/distribute-10.ts — top up wallets 1-10 with ETH + USDC.
//
// Source funds: operator (idx 0) for ETH, the wallet with the most
// USDC for token. Targets: each agent gets ~MIN_ETH gas and MIN_USDC
// stake/fee budget.

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseUnits,
  formatUnits,
  type Address,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const MIN_ETH = parseEther("0.01");
const MIN_USDC = parseUnits("5", 6); // 5 USDC each
const TARGET_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

const ERC20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

async function main() {
  const wallets = TARGET_INDEXES.map((i) => ({
    idx: i,
    account: mnemonicToAccount(MNEMONIC, { addressIndex: i }),
  }));

  // Find the wallet with the most USDC to act as USDC source.
  const usdcBalances = await Promise.all(
    [0, 1, 2, 3, 4, 5].map(async (i) => {
      const acc = mnemonicToAccount(MNEMONIC, { addressIndex: i });
      const bal = (await pub.readContract({
        address: USDC,
        abi: ERC20,
        functionName: "balanceOf",
        args: [acc.address],
      })) as bigint;
      return { idx: i, address: acc.address, balance: bal };
    }),
  );
  const usdcSource = usdcBalances.reduce((a, b) =>
    b.balance > a.balance ? b : a,
  );
  console.log(
    `USDC source: idx ${usdcSource.idx} (${usdcSource.address}) = ${formatUnits(usdcSource.balance, 6)} USDC`,
  );

  const operator = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  console.log(`ETH source (operator): ${operator.address}`);

  // ── Distribute ETH from operator ─────────────────────────────────
  const operatorWallet = createWalletClient({
    account: operator,
    chain: baseSepolia,
    transport: http(RPC),
  });
  for (const w of wallets) {
    const eth = await pub.getBalance({ address: w.account.address });
    if (eth >= MIN_ETH) {
      console.log(`  idx ${w.idx} eth=${formatUnits(eth, 18)} ok`);
      continue;
    }
    const need = MIN_ETH - eth;
    console.log(
      `  idx ${w.idx} sending ${formatUnits(need, 18)} ETH from operator → ${w.account.address}`,
    );
    const hash = await operatorWallet.sendTransaction({
      to: w.account.address,
      value: need,
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`    ✓ ${hash}`);
  }

  // ── Distribute USDC from richest wallet ──────────────────────────
  if (usdcSource.idx === 0) {
    console.warn("USDC source is operator; this is unusual. Continuing.");
  }
  const usdcAccount = mnemonicToAccount(MNEMONIC, {
    addressIndex: usdcSource.idx,
  });
  const usdcWallet = createWalletClient({
    account: usdcAccount,
    chain: baseSepolia,
    transport: http(RPC),
  });

  for (const w of wallets) {
    if (w.idx === usdcSource.idx) {
      console.log(`  idx ${w.idx} (USDC source) — skipping`);
      continue;
    }
    const bal = (await pub.readContract({
      address: USDC,
      abi: ERC20,
      functionName: "balanceOf",
      args: [w.account.address],
    })) as bigint;
    if (bal >= MIN_USDC) {
      console.log(`  idx ${w.idx} usdc=${formatUnits(bal, 6)} ok`);
      continue;
    }
    const need = MIN_USDC - bal;
    console.log(
      `  idx ${w.idx} sending ${formatUnits(need, 6)} USDC → ${w.account.address}`,
    );
    const hash = await usdcWallet.writeContract({
      address: USDC,
      abi: ERC20,
      functionName: "transfer",
      args: [w.account.address, need],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`    ✓ ${hash}`);
  }

  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
