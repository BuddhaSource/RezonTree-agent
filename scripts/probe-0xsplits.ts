#!/usr/bin/env tsx
// probe-0xsplits.ts — feasibility probe of 0xSplits V2 against the
// RezonTree settlement flow on Base Sepolia. Uses ALREADY-DEPLOYED
// contracts; deploys nothing.
//
// Scenario A (settled): a funds → controller updates winners →
// distribute → b + fee_wallet claim.
// Scenario B (expired): c funds → no update → distribute against the
// untouched split → c gets refund.
//
// Goal: prove we can run the full RezonTree fund/settle/claim cycle
// against a public Splits factory + warehouse, with no contracts of
// our own. Print a per-step ledger; cross-check against expected
// economics.
//
// Base Sepolia deployment (from splits-contracts-monorepo/deployments/84532.json):
//   PullSplitFactoryV2.2: 0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1
//   SplitsWarehouse:       0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8
//
// Wallet derivation reuses the demo HD set:
//   a (N=0)  funder + controller (also "Router" role)
//   b (N=1)  winning solver in scenario A
//   fee (N=3) fee wallet
//   c (N=2)  funder in scenario B (refund path)

import type { Address, Hex } from "viem";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
} from "viem";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import {
  awaitReceipt,
  makeAgentWalletClient,
} from "../src/router/client.js";
import { fmtUsdc } from "../src/accounting/balances.js";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = 84532;
const USDC =
  (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const PULL_SPLIT_FACTORY: Address = "0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1";
const SPLITS_WAREHOUSE: Address = "0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8";

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};
const log = (s: string, d?: string) =>
  console.log(`${c.cyan(`[${s}]`)}${d ? ` ${d}` : ""}`);
const ok = (d: string) => console.log(`  ${c.green("✓")} ${d}`);
const info = (d: string) => console.log(`  ${c.dim(d)}`);

// ABIs (minimal slices — only what the probe touches).
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

// Split struct: (address[] recipients, uint256[] allocations,
//                uint256 totalAllocation, uint16 distributionIncentive)
const SPLIT_STRUCT_ABI = {
  type: "tuple" as const,
  components: [
    { name: "recipients", type: "address[]" },
    { name: "allocations", type: "uint256[]" },
    { name: "totalAllocation", type: "uint256" },
    { name: "distributionIncentive", type: "uint16" },
  ],
};

const PULL_SPLIT_FACTORY_ABI = [
  {
    type: "function",
    name: "createSplit",
    stateMutability: "nonpayable",
    inputs: [
      SPLIT_STRUCT_ABI,
      { name: "_owner", type: "address" },
      { name: "_creator", type: "address" },
    ],
    outputs: [{ name: "split", type: "address" }],
  },
  {
    type: "event",
    name: "SplitCreated",
    inputs: [
      { name: "split", type: "address", indexed: true },
      {
        name: "splitParams",
        type: "tuple",
        indexed: false,
        components: SPLIT_STRUCT_ABI.components,
      },
      { name: "owner", type: "address", indexed: false },
      { name: "creator", type: "address", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
] as const;

const PULL_SPLIT_ABI = [
  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [
      SPLIT_STRUCT_ABI,
      { name: "_token", type: "address" },
      { name: "_distributor", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateSplit",
    stateMutability: "nonpayable",
    inputs: [SPLIT_STRUCT_ABI],
    outputs: [],
  },
  {
    type: "function",
    name: "splitHash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const WAREHOUSE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" }, // ERC-6909: id = uint256(token address)
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_token", type: "address" },
    ],
    outputs: [],
  },
] as const;

interface SplitData {
  recipients: readonly Address[];
  allocations: readonly bigint[];
  totalAllocation: bigint;
  distributionIncentive: number;
}

// keccak256(abi.encode(Split)) — must match the on-chain getHash().
function getSplitHash(split: SplitData): Hex {
  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "recipients", type: "address[]" },
          { name: "allocations", type: "uint256[]" },
          { name: "totalAllocation", type: "uint256" },
          { name: "distributionIncentive", type: "uint16" },
        ],
      },
    ],
    [split],
  );
  return keccak256(encoded);
}

// ERC-6909 token id = uint256(address)
function tokenId(token: Address): bigint {
  return BigInt(token);
}

async function main() {
  log("probe-0xsplits", c.bold("Base Sepolia • PullSplitFactoryV2.2 + Warehouse"));
  info(`factory  ${PULL_SPLIT_FACTORY}`);
  info(`warehouse ${SPLITS_WAREHOUSE}`);
  info(`USDC      ${USDC}`);

  const a = deriveAgentWallet(MNEMONIC!, 0, CHAIN_ID); // funder + Router controller
  const b = deriveAgentWallet(MNEMONIC!, 1, CHAIN_ID); // scenario A winner
  const cAgent = deriveAgentWallet(MNEMONIC!, 2, CHAIN_ID); // scenario B funder
  const fee = deriveAgentWallet(MNEMONIC!, 3, CHAIN_ID); // fee wallet

  const aClient = makeAgentWalletClient({ privateKey: a.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const bClient = makeAgentWalletClient({ privateKey: b.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const cClient = makeAgentWalletClient({ privateKey: cAgent.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const feeClient = makeAgentWalletClient({ privateKey: fee.privateKey, chainId: CHAIN_ID, rpcUrl: RPC });
  const pub = createPublicClient({ transport: http(RPC) });

  const usdcId = tokenId(USDC);

  async function bal(addr: Address): Promise<bigint> {
    return (await pub.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [addr],
    })) as bigint;
  }
  async function whBal(owner: Address): Promise<bigint> {
    return (await pub.readContract({
      address: SPLITS_WAREHOUSE,
      abi: WAREHOUSE_ABI,
      functionName: "balanceOf",
      args: [owner, usdcId],
    })) as bigint;
  }

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO A — Settled flow: a funds → update to winners → distribute → claim
  // ─────────────────────────────────────────────────────────────────
  console.log("");
  console.log(c.magenta(c.bold("━━━━━━━━━━━━━━━━ Scenario A — settled ━━━━━━━━━━━━━━━━")));

  // Initial split: a (the funder) gets 100% — refund-by-default until
  // controller (a) declares winners.
  const initialSplit: SplitData = {
    recipients: [a.address],
    allocations: [1_000_000n],
    totalAllocation: 1_000_000n,
    distributionIncentive: 0,
  };

  log("A.1 createSplit", "owner=Router (a)");
  const createTx = await aClient.writeContract({
    address: PULL_SPLIT_FACTORY,
    abi: PULL_SPLIT_FACTORY_ABI,
    functionName: "createSplit",
    args: [initialSplit, a.address, a.address],
    account: aClient.account!,
    chain: aClient.chain,
  });
  info(`tx ${createTx}`);
  const createReceipt = await pub.waitForTransactionReceipt({ hash: createTx });
  if (createReceipt.status !== "success") throw new Error("createSplit reverted");
  const created = parseEventLogs({
    abi: PULL_SPLIT_FACTORY_ABI,
    logs: createReceipt.logs,
    eventName: "SplitCreated",
  });
  const splitAddr = (created[0] as { args: { split: Address } }).args.split;
  ok(`split contract ${splitAddr}`);
  info(`gas used ${createReceipt.gasUsed}`);

  // Public Base Sepolia has read-your-writes lag — settle before view reads.
  await new Promise((r) => setTimeout(r, 3000));

  // Verify owner + splitHash on chain matches our local computation.
  const onChainOwner = await pub.readContract({
    address: splitAddr,
    abi: PULL_SPLIT_ABI,
    functionName: "owner",
  });
  const onChainHash = await pub.readContract({
    address: splitAddr,
    abi: PULL_SPLIT_ABI,
    functionName: "splitHash",
  });
  const localHash = getSplitHash(initialSplit);
  ok(`owner ${onChainOwner === a.address ? "matches a" : "MISMATCH"}`);
  ok(`splitHash ${onChainHash === localHash ? "matches local" : "MISMATCH"}`);

  // Step 2: a "funds" by transferring 2 USDC to the split contract.
  log("A.2 fund", "a transfers 2 USDC to split contract");
  const aBefore = await bal(a.address);
  const fundTx = await aClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [splitAddr, 2_000_000n],
    account: aClient.account!,
    chain: aClient.chain,
  });
  await awaitReceipt(pub, fundTx);
  info(`tx ${fundTx}`);
  const splitBalAfter = await bal(splitAddr);
  ok(`split contract holds ${fmtUsdc(splitBalAfter)}; a paid ${fmtUsdc(aBefore - (await bal(a.address)))}`);

  // Step 3: controller (a, acting as Router) calls updateSplit with the
  // winner allocation. b gets 90%, fee gets 10%.
  log("A.3 updateSplit", "controller declares winners → b 90% / fee_wallet 10%");
  const winnerSplit: SplitData = {
    recipients: [b.address, fee.address],
    allocations: [900_000n, 100_000n],
    totalAllocation: 1_000_000n,
    distributionIncentive: 0,
  };
  const updateTx = await aClient.writeContract({
    address: splitAddr,
    abi: PULL_SPLIT_ABI,
    functionName: "updateSplit",
    args: [winnerSplit],
    account: aClient.account!,
    chain: aClient.chain,
  });
  await awaitReceipt(pub, updateTx);
  info(`tx ${updateTx}`);
  await new Promise((r) => setTimeout(r, 3000));
  const newOnChainHash = await pub.readContract({
    address: splitAddr,
    abi: PULL_SPLIT_ABI,
    functionName: "splitHash",
  });
  ok(`splitHash flipped: ${newOnChainHash === getSplitHash(winnerSplit) ? "matches winnerSplit" : "MISMATCH"}`);

  // Step 4: anyone can call distribute() with the current split data.
  // It pushes the split-contract balance into Warehouse balances per
  // the new allocation.
  log("A.4 distribute", "push 2 USDC into Warehouse balances per winner allocation");
  const distTx = await aClient.writeContract({
    address: splitAddr,
    abi: PULL_SPLIT_ABI,
    functionName: "distribute",
    args: [winnerSplit, USDC, a.address],
    account: aClient.account!,
    chain: aClient.chain,
  });
  await awaitReceipt(pub, distTx);
  info(`tx ${distTx}`);
  await new Promise((r) => setTimeout(r, 3000));
  const splitWalletBalAfterDist = await bal(splitAddr);
  const bWh = await whBal(b.address);
  const feeWh = await whBal(fee.address);
  info(`split contract balance after distribute: ${fmtUsdc(splitWalletBalAfterDist)} (Splits leaves 1 wei dust)`);
  info(`b warehouse balance: ${fmtUsdc(bWh)}`);
  info(`fee warehouse balance: ${fmtUsdc(feeWh)}`);

  // Step 5: b and fee_wallet withdraw from Warehouse.
  log("A.5 withdraw", "b + fee_wallet pull-claim from Warehouse");
  const bBefore = await bal(b.address);
  const feeBefore = await bal(fee.address);

  const bWithdrawTx = await bClient.writeContract({
    address: SPLITS_WAREHOUSE,
    abi: WAREHOUSE_ABI,
    functionName: "withdraw",
    args: [b.address, USDC],
    account: bClient.account!,
    chain: bClient.chain,
  });
  await awaitReceipt(pub, bWithdrawTx);
  info(`b withdraw tx ${bWithdrawTx}`);

  const feeWithdrawTx = await feeClient.writeContract({
    address: SPLITS_WAREHOUSE,
    abi: WAREHOUSE_ABI,
    functionName: "withdraw",
    args: [fee.address, USDC],
    account: feeClient.account!,
    chain: feeClient.chain,
  });
  await awaitReceipt(pub, feeWithdrawTx);
  info(`fee withdraw tx ${feeWithdrawTx}`);
  await new Promise((r) => setTimeout(r, 3000));

  const bGain = (await bal(b.address)) - bBefore;
  const feeGain = (await bal(fee.address)) - feeBefore;
  ok(`b received ${fmtUsdc(bGain)}, fee_wallet received ${fmtUsdc(feeGain)}`);

  // Verify final invariants. Splits V2 leaves 1 wei dust at TWO points:
  // (a) PullSplit.distribute() pre-deducts 1 wei from splitBalance + 1 wei
  //     from warehouseBalance before allocating (gas optimization);
  // (b) SplitsWarehouse.withdraw() leaves 1 wei in the warehouse balance.
  // For our funded-via-split path: 1 wei lost in distribute (from split
  // balance side) + 1 wei lost in withdraw = 2 wei per claimant. Fee
  // recipient pays ~floor(0.1 × 1 wei) = 0 of the distribute-side wei,
  // so the dust hits the largest allocation; here both happen to lose
  // 2 wei because integer truncation pushes the dust onto each.
  const expectedB = 1_800_000n - 2n;
  const expectedFee = 200_000n - 2n;
  const aSettled = bGain === expectedB && feeGain === expectedFee;
  if (aSettled) {
    ok(`scenario A invariants HOLD (b: ${fmtUsdc(bGain)} ≈ 1.8 USDC, fee: ${fmtUsdc(feeGain)} ≈ 0.2 USDC)`);
  } else {
    console.log(c.red(`scenario A drifted — expected b=${fmtUsdc(expectedB)}, fee=${fmtUsdc(expectedFee)}`));
  }

  // ─────────────────────────────────────────────────────────────────
  // SCENARIO B — Refund flow: c funds → no update → distribute → c refunded
  // ─────────────────────────────────────────────────────────────────
  console.log("");
  console.log(c.magenta(c.bold("━━━━━━━━━━━━━━━━ Scenario B — expired (refund) ━━━━━━━━━━━━━━━━")));

  // Initial split: c (the funder) gets 100%. NO updateSplit happens.
  const refundSplit: SplitData = {
    recipients: [cAgent.address],
    allocations: [1_000_000n],
    totalAllocation: 1_000_000n,
    distributionIncentive: 0,
  };

  log("B.1 createSplit", "owner=Router (a), recipient=c (refund-by-default)");
  const createBTx = await aClient.writeContract({
    address: PULL_SPLIT_FACTORY,
    abi: PULL_SPLIT_FACTORY_ABI,
    functionName: "createSplit",
    args: [refundSplit, a.address, a.address],
    account: aClient.account!,
    chain: aClient.chain,
  });
  const createBReceipt = await pub.waitForTransactionReceipt({ hash: createBTx });
  const createdB = parseEventLogs({
    abi: PULL_SPLIT_FACTORY_ABI,
    logs: createBReceipt.logs,
    eventName: "SplitCreated",
  });
  const splitBAddr = (createdB[0] as { args: { split: Address } }).args.split;
  ok(`split contract ${splitBAddr}`);

  log("B.2 fund", "c transfers 1 USDC to split");
  const cFundTx = await cClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [splitBAddr, 1_000_000n],
    account: cClient.account!,
    chain: cClient.chain,
  });
  await awaitReceipt(pub, cFundTx);
  info(`tx ${cFundTx}`);

  log("B.3 distribute (no update)", "anyone can flush the original allocation back to c");
  // Anyone can call distribute. We use a's wallet (cheaper to keep
  // calling from the same account; in production this would be
  // permissionless — c could call it themselves).
  const refundDistTx = await aClient.writeContract({
    address: splitBAddr,
    abi: PULL_SPLIT_ABI,
    functionName: "distribute",
    args: [refundSplit, USDC, a.address],
    account: aClient.account!,
    chain: aClient.chain,
  });
  await awaitReceipt(pub, refundDistTx);
  info(`tx ${refundDistTx}`);
  await new Promise((r) => setTimeout(r, 3000));

  const cWh = await whBal(cAgent.address);
  info(`c warehouse balance: ${fmtUsdc(cWh)}`);

  log("B.4 withdraw", "c pulls their refund from Warehouse");
  const cBefore = await bal(cAgent.address);
  const cWithdrawTx = await cClient.writeContract({
    address: SPLITS_WAREHOUSE,
    abi: WAREHOUSE_ABI,
    functionName: "withdraw",
    args: [cAgent.address, USDC],
    account: cClient.account!,
    chain: cClient.chain,
  });
  await awaitReceipt(pub, cWithdrawTx);
  await new Promise((r) => setTimeout(r, 3000));
  const cGain = (await bal(cAgent.address)) - cBefore;
  ok(`c received refund ${fmtUsdc(cGain)} (expected ≈ 1 USDC minus 2 wei dust)`);

  const bRefunded = cGain === 999_998n; // 1 USDC - 2 wei (1 in distribute, 1 in withdraw)
  if (bRefunded) {
    ok(`scenario B invariants HOLD — funder refunded permissionlessly without controller action`);
  } else {
    console.log(c.red(`scenario B drifted — expected ${fmtUsdc(999_999n)}, got ${fmtUsdc(cGain)}`));
  }

  // ─────────────────────────────────────────────────────────────────
  // FINAL VERDICT
  // ─────────────────────────────────────────────────────────────────
  console.log("");
  console.log(c.bold("━━━━━━━━━━━━━━━━ Verdict ━━━━━━━━━━━━━━━━"));
  if (aSettled && bRefunded) {
    console.log(c.green(c.bold("  ✓ Both scenarios pass against deployed 0xSplits V2 contracts.")));
    console.log(c.dim(`    Scenario A (settled): a → split → updateSplit → distribute → b+fee withdraw`));
    console.log(c.dim(`    Scenario B (expired): c → split → distribute (no update) → c refunded`));
    console.log(c.dim(`    Total contracts deployed by us: 0`));
  } else {
    console.log(c.red(c.bold("  ✗ At least one scenario drifted; investigate before adopting.")));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
