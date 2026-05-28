// recover-abandon-sweep.ts — dynamic sweep of all abandoned questions
// with confirmed contributions whose chain pool portion is still > 0.
//
// Mirrors recover-abandoned-refunds.ts but pulls the (qid, sponsorIdx)
// pairs from the live DB instead of a hardcoded list. Use this after a
// swarm run where many questions abandoned.
//
// Usage:
//   set -a; source .env; set +a
//   npx tsx scripts/recover-abandon-sweep.ts

import { mnemonicToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
} from "viem";
import { baseSepolia } from "viem/chains";
import { Client } from "pg";

const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const FORGE = process.env.RT_FORGE_ADDRESS as `0x${string}`;
const USDC =
  (process.env.RT_USDC_ADDRESS ||
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;
const RPC = process.env.FORGE_RPC_URL || "https://sepolia.base.org";

if (!MNEMONIC || !FORGE) {
  console.error("Missing RT_AGENT_MNEMONIC or RT_FORGE_ADDRESS");
  process.exit(1);
}

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
] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

// Derive idx from address — operator has the 12 wallet HD list; map by
// address-lowercase to idx so we know which wallet to sign with.
function addrToIdxMap(): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i <= 11; i++) {
    const a = mnemonicToAccount(MNEMONIC, { addressIndex: i });
    m.set(a.address.toLowerCase(), i);
  }
  return m;
}

async function loadTargets() {
  const pg = new Client({
    host: "localhost",
    port: 5432,
    user: "rezontree",
    password: "rezontree",
    database: "rezontree",
  });
  await pg.connect();
  try {
    // Abandoned questions with sponsor address + qid hex.
    const r = await pg.query<{
      question_id: string;
      qid_hex: string;
      sponsor: string;
    }>(`
      SELECT q.id AS question_id,
             encode(q.qid, 'hex') AS qid_hex,
             encode(c.funder_address, 'hex') AS sponsor
        FROM questions q
        JOIN rounds r ON r.question_id = q.id
        JOIN contributions c ON c.round_id = r.id
       WHERE q.status = 'abandoned'
         AND c.confirmation_status = 'confirmed'
       ORDER BY q.id
    `);
    return r.rows;
  } finally {
    await pg.end();
  }
}

async function main() {
  console.log(`Forge:  ${FORGE}`);
  console.log(`USDC:   ${USDC}`);
  console.log(`RPC:    ${RPC}`);

  const targets = await loadTargets();
  const idxMap = addrToIdxMap();
  console.log(`Found ${targets.length} (qid, sponsor) pairs on abandoned questions.`);

  let totalRecovered = 0n;
  let skipped = 0;
  let recovered = 0;
  let failed = 0;

  for (const t of targets) {
    const sponsorAddr = ("0x" + t.sponsor) as `0x${string}`;
    const qid = ("0x" + t.qid_hex) as `0x${string}`;
    const idx = idxMap.get(sponsorAddr.toLowerCase());
    if (idx === undefined) {
      console.log(`\n── ${t.question_id}`);
      console.log(`   sponsor:  ${sponsorAddr} — NOT in agent HD wallet pool; skipping`);
      skipped++;
      continue;
    }

    console.log(`\n── ${t.question_id}`);
    console.log(`   sponsor: ${sponsorAddr} (idx ${idx})`);
    console.log(`   qid:     ${qid}`);

    // Check chain-side pool portion.
    let poolPortion: bigint;
    try {
      poolPortion = (await pub.readContract({
        address: FORGE,
        abi: FORGE_ABI,
        functionName: "sponsorPoolByAddress",
        args: [qid, sponsorAddr],
      })) as bigint;
    } catch (e: any) {
      console.log(`   chain read FAIL: ${e.shortMessage || e.message}`);
      failed++;
      continue;
    }
    console.log(`   chain pool: ${formatUnits(poolPortion, 6)} USDC`);

    if (poolPortion === 0n) {
      console.log(`   SKIP — chain ledger shows zero (already refunded or never had pool).`);
      skipped++;
      continue;
    }

    const account = mnemonicToAccount(MNEMONIC, { addressIndex: idx });
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(RPC),
    });

    const beforeUsdc = (await pub.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [sponsorAddr],
    })) as bigint;

    try {
      const hash = await wallet.writeContract({
        address: FORGE,
        abi: FORGE_ABI,
        functionName: "sponsorRefund",
        args: [qid],
      });
      console.log(`   tx:        ${hash}`);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      console.log(
        `   status:    ${receipt.status === "success" ? "✓ success" : "✗ reverted"} (block ${receipt.blockNumber})`,
      );

      const afterUsdc = (await pub.readContract({
        address: USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [sponsorAddr],
      })) as bigint;
      const delta = afterUsdc - beforeUsdc;
      console.log(`   recovered: +${formatUnits(delta, 6)} USDC`);
      totalRecovered += delta;
      recovered++;
    } catch (e: any) {
      console.log(`   FAIL: ${e.shortMessage || e.message}`);
      failed++;
    }
  }

  console.log(
    `\n── Done. recovered ${recovered}, skipped ${skipped}, failed ${failed}, total +${formatUnits(totalRecovered, 6)} USDC`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
