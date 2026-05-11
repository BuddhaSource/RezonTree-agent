// recover-abandoned-refunds.ts — calls RezonForge.sponsorRefund(qid)
// for the 3 stuck contributions on abandoned questions where
// refunded_at IS NULL.
//
// Pull-refund: only the original sponsor wallet (msg.sender) can
// recover its pool-portion. Script derives the right signer from
// the HD mnemonic via the wallet-index map (idx 1 = questioner-01,
// idx 6 = solver-05).

import { mnemonicToAccount } from "viem/accounts";
import {
  createPublicClient, createWalletClient, http, parseUnits,
  formatUnits,
} from "viem";
import { baseSepolia } from "viem/chains";

const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const FORGE = process.env.RT_FORGE_ADDRESS as `0x${string}`;
const USDC = (process.env.RT_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;
const RPC = process.env.FORGE_RPC_URL || "https://sepolia.base.org";

if (!MNEMONIC || !FORGE) {
  console.error("Missing RT_AGENT_MNEMONIC or RT_FORGE_ADDRESS");
  process.exit(1);
}

// Stuck contributions identified via psql audit:
const STUCK = [
  {
    qid: "0xc4165fcfce718ec22bf07c4c82911e191dd5ea2e9cfaf838920dba2112076ce8" as `0x${string}`,
    questionId: "qst_d7zaps856bv3e4p4121g",
    sponsorIdx: 1, // 0x483c51...
    expectedUsdc: 5.0,
  },
  {
    qid: "0x95f5072fe3095a237cacb7ee0a5cf814a65e99dbe25a8e53c67d2eaf198155e6" as `0x${string}`,
    questionId: "qst_d7x8zxwtbev4nw4qs2gg",
    sponsorIdx: 1,
    expectedUsdc: 1.0,
  },
  {
    qid: "0x2056ef2cfd1d111c1e9842daefb93fc2bbd10197e1835dc79e21ffd091db5d35" as `0x${string}`,
    questionId: "qst_d7zav8tv4wjt4ty9gcsg",
    sponsorIdx: 6, // 0x42f775...
    expectedUsdc: 1.0,
  },
];

const FORGE_ABI = [
  {
    name: "sponsorRefund",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "questionId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "sponsorPoolByAddress",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "sponsor", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

async function recoverOne(s: typeof STUCK[0]) {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: s.sponsorIdx });
  console.log(`\n── ${s.questionId}`);
  console.log(`   sponsor:    ${account.address} (idx ${s.sponsorIdx})`);
  console.log(`   qid:        ${s.qid}`);
  console.log(`   expected:   ${s.expectedUsdc} USDC`);

  // Read chain pool portion this sponsor is entitled to.
  const poolPortion = (await pub.readContract({
    address: FORGE,
    abi: FORGE_ABI,
    functionName: "sponsorPoolByAddress",
    args: [s.qid, account.address],
  })) as bigint;
  console.log(`   chain pool: ${formatUnits(poolPortion, 6)} USDC`);

  if (poolPortion === 0n) {
    console.log(`   SKIP — chain ledger shows zero (already refunded or never had a pool portion).`);
    return { questionId: s.questionId, status: "skip-zero", recovered: 0n };
  }

  const beforeUsdc = (await pub.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC),
  });

  try {
    const hash = await wallet.writeContract({
      address: FORGE,
      abi: FORGE_ABI,
      functionName: "sponsorRefund",
      args: [s.qid],
    });
    console.log(`   tx:         ${hash}`);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`   status:     ${receipt.status === "success" ? "✓ success" : "✗ reverted"} (block ${receipt.blockNumber})`);

    const afterUsdc = (await pub.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    const delta = afterUsdc - beforeUsdc;
    console.log(`   recovered:  +${formatUnits(delta, 6)} USDC`);
    return {
      questionId: s.questionId,
      status: receipt.status,
      txHash: hash,
      recovered: delta,
    };
  } catch (e: any) {
    console.log(`   FAIL: ${e.shortMessage || e.message}`);
    return {
      questionId: s.questionId,
      status: "fail",
      error: e.shortMessage || e.message,
      recovered: 0n,
    };
  }
}

async function main() {
  console.log(`Forge:  ${FORGE}`);
  console.log(`USDC:   ${USDC}`);
  console.log(`RPC:    ${RPC}`);
  console.log(`Recovering ${STUCK.length} stuck refunds…`);

  let totalRecovered = 0n;
  for (const s of STUCK) {
    const r = await recoverOne(s);
    if (typeof r.recovered === "bigint") totalRecovered += r.recovered;
  }

  console.log(`\n── Total recovered: ${formatUnits(totalRecovered, 6)} USDC`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
