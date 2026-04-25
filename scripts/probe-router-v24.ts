#!/usr/bin/env tsx
// probe-router-v24.ts — single-round end-to-end test of RouterV24
// against the live 0xSplits V2 contracts on Base Sepolia. No backend.
// Constructs intents inline, signs locally, broadcasts.
//
// Wallets (BIP-44 m/44'/60'/0'/0/N):
//   a (N=0)  funder + oracle
//   b (N=1)  winning solver
//   c (N=2)  losing solver (commit bond gets slashed)
//   d (N=4)  correct voter (votes for b)
//   fee (N=3) platform fee wallet
//
// Round economics with PLATFORM_FEE_BPS=1000 (10%) and 1 USDC bonds:
//   bounty:      a → split:        2 USDC
//   commit fees: 0
//   vote fees:   0
//   slashed bonds: c.commit (1 USDC)
//   expanded pool at settle: 2 + 1 = 3 USDC
//   winner b:    3 × 0.9 = 2.7 USDC
//   fee_wallet:  3 × 0.1 = 0.3 USDC
//   bond refunds: b (1 USDC), d (1 USDC)
//
// Per-wallet cumulative:
//   a:   -2 (funded)
//   b:   -1 (commit bond posted) + 2.7 (pool) + 1 (bond refund) = +2.7 net
//   c:   -1 (commit bond slashed)
//   d:    0 (vote bond refunded)
//   fee: +0.3 (platform cut)
//   Router net: 0
//   Split net: 0 (drained at settle)
//   Conservation: -2 + 2.7 -1 + 0 + 0.3 = 0 ✓

import type { Address, Hex } from "viem";
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { signUSDCPermit } from "../src/router/permit.js";
import {
  awaitReceipt,
  makeAgentWalletClient,
} from "../src/router/client.js";
import { fmtUsdc } from "../src/accounting/balances.js";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = 84532n;
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROUTER_V24: Address = "0x19b4eeec1feba0072a447903bb7f55dc906d975f";
const SPLITS_WAREHOUSE: Address = "0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

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
const fail = (d: string) => console.log(`  ${c.red("✗")} ${d}`);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

// SplitParams tuple matching RouterV24 + 0xSplits SplitV2Lib.
const SPLIT_PARAMS_TUPLE = {
  type: "tuple" as const,
  components: [
    { name: "recipients", type: "address[]" },
    { name: "allocations", type: "uint256[]" },
    { name: "totalAllocation", type: "uint256" },
    { name: "distributionIncentive", type: "uint16" },
  ],
};

const ROUTER_V24_ABI = [
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "funder", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      { name: "intentSig", type: "bytes" },
      { name: "permitV", type: "uint8" },
      { name: "permitR", type: "bytes32" },
      { name: "permitS", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "commitSolution",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "submitter", type: "address" },
          { name: "contentHash", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "bondAmount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      { name: "intentSig", type: "bytes" },
      { name: "permitV", type: "uint8" },
      { name: "permitR", type: "bytes32" },
      { name: "permitS", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "castVote",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "questionId", type: "bytes32" },
          { name: "voter", type: "address" },
          { name: "allocationsHash", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "bondAmount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      { name: "intentSig", type: "bytes" },
      { name: "permitV", type: "uint8" },
      { name: "permitR", type: "bytes32" },
      { name: "permitS", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "publishSettlement",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      SPLIT_PARAMS_TUPLE,
      { name: "expiresAt", type: "uint256" },
      { name: "slashedCommitHashes", type: "bytes32[]" },
      { name: "slashedVoteHashes", type: "bytes32[]" },
      { name: "oracleSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimSolutionBond",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "intentHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimVoteBond",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "intentHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "splitOf",
    stateMutability: "view",
    inputs: [{ name: "qid", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "questions",
    stateMutability: "view",
    inputs: [{ name: "qid", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "tokenAddr", type: "address" },
      { name: "solutionCount", type: "uint32" },
      { name: "poolAmount", type: "uint256" },
      { name: "fundingDeadline", type: "uint256" },
    ],
  },
] as const;

const WAREHOUSE_ABI = [
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
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// EIP-712 domain — matches RouterV24's DOMAIN_NAME_HASH/VERSION_HASH.
const DOMAIN = {
  name: "RezonTreeRouter",
  version: "2",
  chainId: Number(CHAIN_ID),
  verifyingContract: ROUTER_V24,
} as const;

const FUND_INTENT_TYPES = {
  FundIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "funder", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

const COMMIT_INTENT_TYPES = {
  CommitIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "submitter", type: "address" },
    { name: "contentHash", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "bondAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

const VOTE_INTENT_TYPES = {
  VoteIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "voter", type: "address" },
    { name: "allocationsHash", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "bondAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

const SETTLEMENT_INTENT_TYPES = {
  SettlementIntent: [
    { name: "questionId", type: "bytes32" },
    { name: "splitHash", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "slashedCommitHashes", type: "bytes32[]" },
    { name: "slashedVoteHashes", type: "bytes32[]" },
  ],
} as const;

interface SplitParams {
  recipients: readonly Address[];
  allocations: readonly bigint[];
  totalAllocation: bigint;
  distributionIncentive: number;
}

function getSplitHash(s: SplitParams): Hex {
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
    [s],
  );
  return keccak256(encoded);
}

async function main() {
  log("probe-router-v24", c.bold(`Router v2.4 ${ROUTER_V24}`));
  info(`Chain: Base Sepolia (${CHAIN_ID})`);
  info(`USDC: ${USDC}`);

  const aWallet = deriveAgentWallet(MNEMONIC!, 0, Number(CHAIN_ID));
  const bWallet = deriveAgentWallet(MNEMONIC!, 1, Number(CHAIN_ID));
  const cWallet = deriveAgentWallet(MNEMONIC!, 2, Number(CHAIN_ID));
  const feeWallet = deriveAgentWallet(MNEMONIC!, 3, Number(CHAIN_ID));
  const dWallet = deriveAgentWallet(MNEMONIC!, 4, Number(CHAIN_ID));

  const aClient = makeAgentWalletClient({ privateKey: aWallet.privateKey, chainId: Number(CHAIN_ID), rpcUrl: RPC });
  const bClient = makeAgentWalletClient({ privateKey: bWallet.privateKey, chainId: Number(CHAIN_ID), rpcUrl: RPC });
  const cClient = makeAgentWalletClient({ privateKey: cWallet.privateKey, chainId: Number(CHAIN_ID), rpcUrl: RPC });
  const dClient = makeAgentWalletClient({ privateKey: dWallet.privateKey, chainId: Number(CHAIN_ID), rpcUrl: RPC });
  const feeClient = makeAgentWalletClient({ privateKey: feeWallet.privateKey, chainId: Number(CHAIN_ID), rpcUrl: RPC });
  const pub = createPublicClient({ transport: http(RPC) });

  const aAccount = privateKeyToAccount(aWallet.privateKey);
  const bAccount = privateKeyToAccount(bWallet.privateKey);
  const cAccount = privateKeyToAccount(cWallet.privateKey);
  const dAccount = privateKeyToAccount(dWallet.privateKey);

  async function bal(addr: Address): Promise<bigint> {
    return (await pub.readContract({
      address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [addr],
    })) as bigint;
  }

  // qid: random per-run so we don't collide with prior probes.
  const qid = keccak256(`0x${Date.now().toString(16).padStart(64, "0")}` as Hex);
  ok(`qid ${qid.slice(0, 18)}…`);

  // Snapshot starting balances.
  const start = {
    a: await bal(aWallet.address),
    b: await bal(bWallet.address),
    cAg: await bal(cWallet.address),
    d: await bal(dWallet.address),
    fee: await bal(feeWallet.address),
    router: await bal(ROUTER_V24),
  };
  console.log("");
  console.log(c.bold("── Starting balances ──"));
  Object.entries(start).forEach(([k, v]) => console.log(`  ${k.padEnd(8)} ${fmtUsdc(v as bigint)}`));

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 600);

  // ─── STEP 1: Fund (a) ────────────────────────────────────────────
  log("1/9 fund", "a → Router.fund(2 USDC)");
  const fundIntent = {
    questionId: qid,
    funder: aWallet.address,
    amount: 2_000_000n,
    nonce: BigInt(Math.floor(Math.random() * 2 ** 32)),
    chainId: CHAIN_ID,
    expiresAt,
  };
  const fundSig = (await aAccount.signTypedData({
    domain: DOMAIN,
    types: FUND_INTENT_TYPES,
    primaryType: "FundIntent",
    message: fundIntent,
  })) as Hex;
  const fundPermit = await signUSDCPermit(aClient, pub, {
    usdc: USDC,
    spender: ROUTER_V24,
    value: fundIntent.amount,
    deadline: fundIntent.expiresAt,
  });
  const fundTx = await aClient.writeContract({
    address: ROUTER_V24,
    abi: ROUTER_V24_ABI,
    functionName: "fund",
    args: [fundIntent, fundSig, fundPermit.v, fundPermit.r, fundPermit.s],
    account: aClient.account!,
    chain: aClient.chain,
    gas: 500_000n,
  });
  await awaitReceipt(pub, fundTx);
  info(`tx ${fundTx}`);
  await new Promise((r) => setTimeout(r, 3000));
  const splitAddr = (await pub.readContract({
    address: ROUTER_V24, abi: ROUTER_V24_ABI, functionName: "splitOf", args: [qid],
  })) as Address;
  ok(`split contract ${splitAddr}`);
  const splitBal = await bal(splitAddr);
  ok(`split holds ${fmtUsdc(splitBal)}`);

  // ─── STEP 2: Commit b (winner) ───────────────────────────────────
  log("2/9 commit", "b → commitSolution (winner; 0 fee, 1 USDC bond)");
  const bContent = "0x" + "b".repeat(64) as Hex;
  const bCommitIntent = {
    questionId: qid,
    submitter: bWallet.address,
    contentHash: bContent,
    feeAmount: 0n,
    bondAmount: 1_000_000n,
    nonce: BigInt(Math.floor(Math.random() * 2 ** 32)),
    chainId: CHAIN_ID,
    expiresAt,
  };
  const bCommitSig = (await bAccount.signTypedData({
    domain: DOMAIN, types: COMMIT_INTENT_TYPES, primaryType: "CommitIntent", message: bCommitIntent,
  })) as Hex;
  const bCommitHash = computeIntentHash("CommitIntent", bCommitIntent);
  const bCommitPermit = await signUSDCPermit(bClient, pub, {
    usdc: USDC, spender: ROUTER_V24,
    value: bCommitIntent.feeAmount + bCommitIntent.bondAmount,
    deadline: bCommitIntent.expiresAt,
  });
  const bCommitTx = await bClient.writeContract({
    address: ROUTER_V24, abi: ROUTER_V24_ABI, functionName: "commitSolution",
    args: [bCommitIntent, bCommitSig, bCommitPermit.v, bCommitPermit.r, bCommitPermit.s],
    account: bClient.account!, chain: bClient.chain, gas: 500_000n,
  });
  await awaitReceipt(pub, bCommitTx);
  info(`tx ${bCommitTx}`);

  // ─── STEP 3: Commit c (loser — bond will be slashed) ─────────────
  log("3/9 commit", "c → commitSolution (loser; bond will be slashed)");
  const cContent = "0x" + "c".repeat(64) as Hex;
  const cCommitIntent = {
    questionId: qid,
    submitter: cWallet.address,
    contentHash: cContent,
    feeAmount: 0n,
    bondAmount: 1_000_000n,
    nonce: BigInt(Math.floor(Math.random() * 2 ** 32)),
    chainId: CHAIN_ID,
    expiresAt,
  };
  const cCommitSig = (await cAccount.signTypedData({
    domain: DOMAIN, types: COMMIT_INTENT_TYPES, primaryType: "CommitIntent", message: cCommitIntent,
  })) as Hex;
  const cCommitHash = computeIntentHash("CommitIntent", cCommitIntent);
  const cCommitPermit = await signUSDCPermit(cClient, pub, {
    usdc: USDC, spender: ROUTER_V24,
    value: cCommitIntent.feeAmount + cCommitIntent.bondAmount,
    deadline: cCommitIntent.expiresAt,
  });
  const cCommitTx = await cClient.writeContract({
    address: ROUTER_V24, abi: ROUTER_V24_ABI, functionName: "commitSolution",
    args: [cCommitIntent, cCommitSig, cCommitPermit.v, cCommitPermit.r, cCommitPermit.s],
    account: cClient.account!, chain: cClient.chain, gas: 500_000n,
  });
  await awaitReceipt(pub, cCommitTx);
  info(`tx ${cCommitTx}`);

  // ─── STEP 4: Vote d (correct) ────────────────────────────────────
  log("4/9 vote", "d → castVote for b (correct; 0 fee, 1 USDC bond)");
  const dAllocHash = keccak256("0x" + "d".repeat(64) as Hex);
  const dVoteIntent = {
    questionId: qid,
    voter: dWallet.address,
    allocationsHash: dAllocHash,
    feeAmount: 0n,
    bondAmount: 1_000_000n,
    nonce: BigInt(Math.floor(Math.random() * 2 ** 32)),
    chainId: CHAIN_ID,
    expiresAt,
  };
  const dVoteSig = (await dAccount.signTypedData({
    domain: DOMAIN, types: VOTE_INTENT_TYPES, primaryType: "VoteIntent", message: dVoteIntent,
  })) as Hex;
  const dVoteHash = computeIntentHash("VoteIntent", dVoteIntent);
  const dVotePermit = await signUSDCPermit(dClient, pub, {
    usdc: USDC, spender: ROUTER_V24,
    value: dVoteIntent.feeAmount + dVoteIntent.bondAmount,
    deadline: dVoteIntent.expiresAt,
  });
  const dVoteTx = await dClient.writeContract({
    address: ROUTER_V24, abi: ROUTER_V24_ABI, functionName: "castVote",
    args: [dVoteIntent, dVoteSig, dVotePermit.v, dVotePermit.r, dVotePermit.s],
    account: dClient.account!, chain: dClient.chain, gas: 500_000n,
  });
  await awaitReceipt(pub, dVoteTx);
  info(`tx ${dVoteTx}`);

  // ─── STEP 5: publishSettlement ───────────────────────────────────
  log("5/9 publishSettlement", "a (oracle) → Router.publishSettlement");
  // Expanded pool = bounty + slashed bonds = 2 + 1 = 3 USDC
  // Distribution: b → 90% (allocation 900_000), fee → 10% (allocation 100_000)
  const winnerSplit: SplitParams = {
    recipients: [bWallet.address, feeWallet.address],
    allocations: [900_000n, 100_000n],
    totalAllocation: 1_000_000n,
    distributionIncentive: 0,
  };
  const splitHash = getSplitHash(winnerSplit);
  info(`splitHash to sign: ${splitHash.slice(0, 18)}…`);
  const settlementIntent = {
    questionId: qid,
    splitHash,
    expiresAt,
    slashedCommitHashes: [cCommitHash],
    slashedVoteHashes: [] as Hex[],
  };
  const oracleSig = (await aAccount.signTypedData({
    domain: DOMAIN, types: SETTLEMENT_INTENT_TYPES,
    primaryType: "SettlementIntent", message: settlementIntent,
  })) as Hex;

  const settleTx = await aClient.writeContract({
    address: ROUTER_V24, abi: ROUTER_V24_ABI, functionName: "publishSettlement",
    args: [
      qid, winnerSplit, expiresAt,
      [cCommitHash], [], oracleSig,
    ],
    account: aClient.account!, chain: aClient.chain, gas: 800_000n,
  });
  await awaitReceipt(pub, settleTx);
  info(`tx ${settleTx}`);
  await new Promise((r) => setTimeout(r, 4000));

  const splitBalAfterSettle = await bal(splitAddr);
  ok(`split contract balance after settle: ${fmtUsdc(splitBalAfterSettle)} (should be ~0; dust acceptable)`);

  // ─── STEP 6: b withdraws from Warehouse ──────────────────────────
  log("6/9 withdraw winner", "b → SplitsWarehouse.withdraw()");
  const bBefore = await bal(bWallet.address);
  const bWithdrawTx = await bClient.writeContract({
    address: SPLITS_WAREHOUSE, abi: WAREHOUSE_ABI, functionName: "withdraw",
    args: [bWallet.address, USDC],
    account: bClient.account!, chain: bClient.chain,
  });
  await awaitReceipt(pub, bWithdrawTx);
  await new Promise((r) => setTimeout(r, 3000));
  const bGain = (await bal(bWallet.address)) - bBefore;
  ok(`b received ${fmtUsdc(bGain)} from pool`);

  // ─── STEP 7: fee_wallet withdraws ────────────────────────────────
  log("7/9 withdraw fee", "fee_wallet → SplitsWarehouse.withdraw()");
  const feeBefore = await bal(feeWallet.address);
  const feeWithdrawTx = await feeClient.writeContract({
    address: SPLITS_WAREHOUSE, abi: WAREHOUSE_ABI, functionName: "withdraw",
    args: [feeWallet.address, USDC],
    account: feeClient.account!, chain: feeClient.chain,
  });
  await awaitReceipt(pub, feeWithdrawTx);
  await new Promise((r) => setTimeout(r, 3000));
  const feeGain = (await bal(feeWallet.address)) - feeBefore;
  ok(`fee_wallet received ${fmtUsdc(feeGain)}`);

  // ─── STEP 8: b claims commit bond ────────────────────────────────
  log("8/9 claim bond", "b → Router.claimSolutionBond");
  const bBondBefore = await bal(bWallet.address);
  const bBondTx = await bClient.writeContract({
    address: ROUTER_V24, abi: ROUTER_V24_ABI, functionName: "claimSolutionBond",
    args: [qid, bCommitHash],
    account: bClient.account!, chain: bClient.chain,
  });
  await awaitReceipt(pub, bBondTx);
  await new Promise((r) => setTimeout(r, 3000));
  const bBondGain = (await bal(bWallet.address)) - bBondBefore;
  ok(`b commit bond refund ${fmtUsdc(bBondGain)}`);

  // ─── STEP 9: d claims vote bond ──────────────────────────────────
  log("9/9 claim vote bond", "d → Router.claimVoteBond");
  const dBondBefore = await bal(dWallet.address);
  const dBondTx = await dClient.writeContract({
    address: ROUTER_V24, abi: ROUTER_V24_ABI, functionName: "claimVoteBond",
    args: [qid, dVoteHash],
    account: dClient.account!, chain: dClient.chain,
  });
  await awaitReceipt(pub, dBondTx);
  await new Promise((r) => setTimeout(r, 3000));
  const dBondGain = (await bal(dWallet.address)) - dBondBefore;
  ok(`d vote bond refund ${fmtUsdc(dBondGain)}`);

  // ─── FINAL AUDIT ─────────────────────────────────────────────────
  const end = {
    a: await bal(aWallet.address),
    b: await bal(bWallet.address),
    cAg: await bal(cWallet.address),
    d: await bal(dWallet.address),
    fee: await bal(feeWallet.address),
    router: await bal(ROUTER_V24),
    split: await bal(splitAddr),
  };
  console.log("");
  console.log(c.bold("━━━━━━━━━━ Per-wallet ledger ━━━━━━━━━━"));
  const dA = end.a - start.a;
  const dB = end.b - start.b;
  const dC = end.cAg - start.cAg;
  const dD = end.d - start.d;
  const dFee = end.fee - start.fee;
  const dRouter = end.router - start.router;
  const dSplit = end.split; // started at 0 (didn't exist)

  console.log(`  a       Δ ${fmtUsdc(dA).padStart(12)}   (expected -2 USDC: bounty)`);
  console.log(`  b       Δ ${fmtUsdc(dB).padStart(12)}   (expected ≈ +2.7 USDC: pool 2.7 + bond 1 - bond posted 1)`);
  console.log(`  c       Δ ${fmtUsdc(dC).padStart(12)}   (expected -1 USDC: bond slashed, no refund)`);
  console.log(`  d       Δ ${fmtUsdc(dD).padStart(12)}   (expected 0: vote bond refunded)`);
  console.log(`  fee     Δ ${fmtUsdc(dFee).padStart(12)}   (expected ≈ +0.3 USDC: 10% of expanded pool)`);
  console.log(`  router  Δ ${fmtUsdc(dRouter).padStart(12)}   (expected 0: bonds in/out cancel)`);
  console.log(`  split   end ${fmtUsdc(dSplit).padStart(10)}   (expected ~0; dust acceptable)`);
  console.log("");

  // Strict invariants:
  //   a delta == -2_000_000 (bounty paid)
  //   c delta == -1_000_000 (bond slashed)
  //   router delta == 0 (bonds fully reconciled)
  //   chain conserved: sum of all deltas + split balance = 0
  let pass = true;
  if (dA !== -2_000_000n) { fail(`a expected -2.0 USDC, got ${fmtUsdc(dA)}`); pass = false; }
  if (dC !== -1_000_000n) { fail(`c expected -1.0 USDC, got ${fmtUsdc(dC)}`); pass = false; }
  // d should be 0 net (bond posted + bond refunded), but Splits dust may eat 0 here since d is a bond-only flow
  if (dD !== 0n) { fail(`d expected 0, got ${fmtUsdc(dD)}`); pass = false; }
  if (dRouter !== 0n) { fail(`router expected 0, got ${fmtUsdc(dRouter)}`); pass = false; }
  // Conservation: sum + split + warehouse leftover = 0
  // Conservation tolerance: 0xSplits leaves 1 wei dust per
  // distribute() in the split + 1 wei per Warehouse.withdraw() in
  // the warehouse balanceOf mapping. We track 2 withdraws + 1
  // distribute = up to 3 wei dust unaccounted-for in tracked
  // wallet balances. Allow ±5 wei.
  const sum = dA + dB + dC + dD + dFee + dRouter + dSplit;
  const absSum = sum < 0n ? -sum : sum;
  if (sum === 0n) {
    ok(`chain total conserved exactly`);
  } else if (absSum <= 5n) {
    ok(`chain total conserved (within 5-wei dust tolerance, drift ${sum} wei)`);
  } else {
    fail(`conservation drift: ${fmtUsdc(sum)} exceeds dust tolerance`);
    pass = false;
  }

  console.log("");
  if (pass) {
    console.log(c.green(c.bold("  ✓ Router v2.4 + 0xSplits — end-to-end PASS")));
    console.log(c.dim(`  qid: ${qid}`));
    console.log(c.dim(`  split: ${splitAddr}`));
  } else {
    console.log(c.red(c.bold("  ✗ Router v2.4 — INVARIANTS DRIFTED")));
    process.exit(1);
  }
}

// computeIntentHash: keccak256(abi.encode(typehash, ...fields)) — must
// match the Router's _hashCommitIntent / _hashVoteIntent so the bond
// claim path can use the same hash.
function computeIntentHash(
  primaryType: "CommitIntent" | "VoteIntent",
  intent: Record<string, unknown>,
): Hex {
  const COMMIT_TH = keccak256(
    new TextEncoder().encode(
      "CommitIntent(bytes32 questionId,address submitter,bytes32 contentHash,uint256 feeAmount,uint256 bondAmount,uint256 nonce,uint256 chainId,uint256 expiresAt)",
    ),
  );
  const VOTE_TH = keccak256(
    new TextEncoder().encode(
      "VoteIntent(bytes32 questionId,address voter,bytes32 allocationsHash,uint256 feeAmount,uint256 bondAmount,uint256 nonce,uint256 chainId,uint256 expiresAt)",
    ),
  );

  if (primaryType === "CommitIntent") {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, // typehash
          { type: "bytes32" }, // questionId
          { type: "address" }, // submitter
          { type: "bytes32" }, // contentHash
          { type: "uint256" }, // feeAmount
          { type: "uint256" }, // bondAmount
          { type: "uint256" }, // nonce
          { type: "uint256" }, // chainId
          { type: "uint256" }, // expiresAt
        ],
        [
          COMMIT_TH,
          intent.questionId as Hex,
          intent.submitter as Address,
          intent.contentHash as Hex,
          intent.feeAmount as bigint,
          intent.bondAmount as bigint,
          intent.nonce as bigint,
          intent.chainId as bigint,
          intent.expiresAt as bigint,
        ],
      ),
    );
  } else {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "address" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [
          VOTE_TH,
          intent.questionId as Hex,
          intent.voter as Address,
          intent.allocationsHash as Hex,
          intent.feeAmount as bigint,
          intent.bondAmount as bigint,
          intent.nonce as bigint,
          intent.chainId as bigint,
          intent.expiresAt as bigint,
        ],
      ),
    );
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
