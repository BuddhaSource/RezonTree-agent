#!/usr/bin/env tsx
/**
 * settle-round5.ts — settle and claim Round 5 (4 questions).
 *
 * Root cause: DB prize_pool was inflated by advisory solutions.fee_amount /
 * votes.fee_amount values that were never actually paid on-chain (commitFee=0
 * on the contract). The stored round_results.merkle_root is therefore wrong.
 * This script recomputes correct Merkle trees using actual on-chain poolAmount
 * values and conviction-vote splits from DB rankings (percentages are correct;
 * absolute amounts need rescaling).
 *
 * For Q4/Q3/Q2: all 2 solutions win → no slashes → totalClaimable = bounty.
 * For Q1: 1 winner, 1 loser → slash loser stake (1M) → totalClaimable = 4M.
 *
 * After settlement, also claims:
 *   - Pool payouts (Merkle claim) for every winner/voter per question
 *   - Solution stakes back (claimSolutionStake) for all solutions
 *   - Vote stakes back (claimVoteStake) for all confirmed votes
 */

import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import dotenv from "dotenv";
import { hashLeaf, buildTreeLevels, merkleProof } from "../src/intents/merkle.js";
import type { MerkleLeaf } from "../src/intents/merkle.js";
import { buildSettlementIntentTypedData, DEFAULT_SETTLEMENT_TTL_SECONDS } from "../src/intents/settlement-intent.js";
import { REZON_FORGE_ABI } from "../src/forge/abi.js";

dotenv.config();

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const FORGE = (process.env.RT_FORGE_ADDRESS ?? "0xb574208ae3E4De77baB58A925faDe34E49BF0790") as Address;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const CHAIN_ID = 84532;

// Derive private key for a given mnemonic index.
function derivePrivKey(idx: number): Hex {
  const { mnemonicToAccount } = require("viem/accounts");
  const acct = mnemonicToAccount(MNEMONIC, { path: `m/44'/60'/0'/0/${idx}` as const });
  return `0x${Buffer.from(acct.getHdKey().privateKey!).toString("hex")}` as Hex;
}

// Address from mnemonic index.
function addrOf(idx: number): Address {
  const { mnemonicToAccount } = require("viem/accounts");
  return mnemonicToAccount(MNEMONIC, { path: `m/44'/60'/0'/0/${idx}` as const }).address as Address;
}

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const log = (s: string, d?: string) => console.log(`${c.cyan(`[${s}]`)}${d ? ` ${d}` : ""}`);
const ok = (d: string) => console.log(`  ${c.green("✓")} ${d}`);
const warn = (d: string) => console.log(`  ${c.yellow("!")} ${d}`);
const info = (d: string) => console.log(`  ${c.dim(d)}`);

// ─── Per-question settlement data from DB ──────────────────────────────────
// Rankings derived from round_results.rankings. Payouts are from the DB
// (computed against inflated prize_pool); we'll rescale them below.
//
// Conviction-vote winner address mapping (from derive-addrs.ts output):
//  idx=0  0x55bd1aae...  (oracle)
//  idx=1  0x483c5106...  questioner-01 / Q3-rank2-author / Q1-winner
//  idx=4  0x7498bec7...  solver / Q4-rank2, Q3-rank1-voter, Q2-rank1-author
//  idx=6  0x42f77513...  solver / Q4-rank1, Q3-rank1-author
//  idx=7  0xf0c36cac...  voter
//  idx=8  0x4c539165...  voter
//  idx=9  0x7201558146... voter

interface RecipientPayout {
  address: Address;
  dbAmount: bigint;  // from DB rankings (may be fractional, truncate to bigint)
}

interface QuestionConfig {
  label: string;
  qid: Hex;
  dbPrizePool: bigint;           // what DB computed (inflated)
  recipients: RecipientPayout[]; // from DB rankings aggregated by address
  slashedCommitHashes: Hex[];    // loser commit intent hashes to slash
  slashedVoteHashes: Hex[];      // loser vote intent hashes to slash
  loserSlashAmount: bigint;      // total stake slashed (added to poolAmount)
  // solution/vote intent hashes for stake-back claims
  solutionIntents: { hash: Hex; ownerIdx: number }[];
  voteIntents: { hash: Hex; ownerIdx: number }[];
}

// Aggregate DB payout amounts per address across all ranks.
// Uses BigInt truncation to avoid floats — fractional payouts (e.g. "531562.5")
// are truncated to 531562n.
function agg(entries: [Address, string][]): RecipientPayout[] {
  const map = new Map<string, bigint>();
  for (const [addr, amtStr] of entries) {
    const key = addr.toLowerCase();
    const existing = map.get(key) ?? 0n;
    map.set(key, existing + BigInt(Math.floor(parseFloat(amtStr))));
  }
  return [...map.entries()].map(([addr, dbAmount]) => ({
    address: addr as Address,
    dbAmount,
  }));
}

const QUESTIONS: QuestionConfig[] = [
  {
    label: "Q4",
    qid: "0x77bc0f714d5538d7e8aae57ddf258e01b15240e4d7d21da57046081de49579a5",
    dbPrizePool: 6300000n,
    recipients: agg([
      // rank1 author 0x42f77513 (idx=6)
      ["0x42f77513cbb4c9166e14a1bf703c82d023c2f16c", "3307500"],
      // rank1 voters
      ["0x483c51061e6106fe4e08e138428336a519fc0533", "531562.5"],
      ["0x4c539165a91878e4be9d90809bf70c6dc31120a3", "354375"],
      ["0xf0c36cac44ca127aae7e31c1913afba677e24501", "531562.5"],
      // rank2 author 0x7498bec7 (idx=4)
      ["0x7498bec7b27896c4fa7df254c5ec8a11dd004601", "1102500"],
      // rank2 voters
      ["0x483c51061e6106fe4e08e138428336a519fc0533", "135000"],
      ["0x4c539165a91878e4be9d90809bf70c6dc31120a3", "202500"],
      ["0xf0c36cac44ca127aae7e31c1913afba677e24501", "135000"],
    ]),
    slashedCommitHashes: [],
    slashedVoteHashes: [],
    loserSlashAmount: 0n,
    solutionIntents: [
      { hash: "0x76b6b40045735900e011ed9166aa7d0c26c5b0dcc537327f3d4a068955fbb455", ownerIdx: 6 },
      { hash: "0x61647ebec4dd0ade0085707ffd5c9405747ce77189e0a0f541cf86457dd473cb", ownerIdx: 4 },
    ],
    voteIntents: [
      { hash: "0xb4098fc1f9b43d38816cbc21b78a51cbcf916b5eec2e48b61bb82b516f63468d", ownerIdx: 1 },
      { hash: "0x143f3dbdd81595f3b5005db337793ef6ae2683165d48054e3427e103e4478b9f", ownerIdx: 8 },
      { hash: "0x424e240d66701c27ad0656ce580dc1c9a3a1737da722099b113399aac8d3f45c", ownerIdx: 7 },
    ],
  },
  {
    label: "Q3",
    qid: "0xb07a09e04557343a0176e32d5d9fd2560cb1dd0f5a0103e6d458573ff61baf7e",
    dbPrizePool: 6350000n,
    recipients: agg([
      // rank1 author 0x42f77513 (idx=6)
      ["0x42f77513cbb4c9166e14a1bf703c82d023c2f16c", "3333750"],
      // rank1 voters
      ["0x7498bec7b27896c4fa7df254c5ec8a11dd004601", "549519.23076923"],
      ["0x483c51061e6106fe4e08e138428336a519fc0533", "549519.23076923"],
      ["0x7201558146b3e52edd6b250b950e030b9440e25b", "164855.76923076"],
      ["0x4c539165a91878e4be9d90809bf70c6dc31120a3", "164855.76923078"],
      // rank2 author 0x483c5106 (idx=1)
      ["0x483c51061e6106fe4e08e138428336a519fc0533", "1111250"],
      // rank2 voters
      ["0x7201558146b3e52edd6b250b950e030b9440e25b", "138906.25"],
      ["0x42f77513cbb4c9166e14a1bf703c82d023c2f16c", "198437.5"],
      ["0x4c539165a91878e4be9d90809bf70c6dc31120a3", "138906.25"],
    ]),
    slashedCommitHashes: [],
    slashedVoteHashes: [],
    loserSlashAmount: 0n,
    solutionIntents: [
      { hash: "0x74a832fabce7a8426c42fa7bfdd8a1fd6e34439d83b948ce1f362881d17d60a9", ownerIdx: 6 },
      { hash: "0x4887bb7fbcbc8fa92cfe3f1719dcec5abbe5f9d2f4557f134792d9475cd75805", ownerIdx: 1 },
    ],
    voteIntents: [
      { hash: "0x1884bb7e42099bdfaad39d3c0df972693285966df553b99f2874b1e689ff415b", ownerIdx: 4 },
      { hash: "0x0aaa314aae4fa7e10b62635b7ea5956cbdf5315dc849dcc0721dd437dddf13fe", ownerIdx: 1 },
      { hash: "0xff00b1675f810aeedb7ca5b42012c711619b1d479a9c93d8f2c6f8ab79c46831", ownerIdx: 9 },
      { hash: "0x6f6858023c330045e9aa92993a2d8afbf8e24296b638e35a0638e9a77e93b1f9", ownerIdx: 6 },
    ],
  },
  {
    label: "Q2",
    qid: "0x66350b7ca1e47afb3080786abf9f99aea3be7611b3bbd8aacf19831d552b4fa1",
    dbPrizePool: 6450000n,
    recipients: agg([
      // rank1 author 0x7498bec7 (idx=4)
      ["0x7498bec7b27896c4fa7df254c5ec8a11dd004601", "3386250"],
      // rank1 voters
      ["0x42f77513cbb4c9166e14a1bf703c82d023c2f16c", "483750"],
      ["0x483c51061e6106fe4e08e138428336a519fc0533", "483750"],
      ["0xf0c36cac44ca127aae7e31c1913afba677e24501", "193500"],
      ["0x7201558146b3e52edd6b250b950e030b9440e25b", "145125"],
      ["0x4c539165a91878e4be9d90809bf70c6dc31120a3", "145125"],
      // rank2 author 0x483c5106 (idx=1)
      ["0x483c51061e6106fe4e08e138428336a519fc0533", "1128750"],
      // rank2 voters
      ["0xf0c36cac44ca127aae7e31c1913afba677e24501", "96750"],
      ["0x7201558146b3e52edd6b250b950e030b9440e25b", "112875"],
      ["0x7498bec7b27896c4fa7df254c5ec8a11dd004601", "161250"],
      ["0x4c539165a91878e4be9d90809bf70c6dc31120a3", "112875"],
    ]),
    slashedCommitHashes: [],
    slashedVoteHashes: [],
    loserSlashAmount: 0n,
    solutionIntents: [
      { hash: "0xe8d70426dd939ce144051716eceeafeb8bc691fc5f81406bdc723c25edd1c717", ownerIdx: 4 },
      { hash: "0xbdb3655f3c489653c6009f73b83024ac89b2fd848cb5d45abfe9ac164fd88358", ownerIdx: 1 },
    ],
    voteIntents: [
      { hash: "0x9605293246939e95803d3c8817667070f8850c0974a9fe565686329378a22dd8", ownerIdx: 6 },
      { hash: "0x085635fdc98520d0dd9fd333044862eb56362abb30f6e3f5f839626fd8c8ad4c", ownerIdx: 1 },
      { hash: "0x43e70dc52572aab6e93cba7b898424d036a7b9b24fd321b92b38adea0f266b1b", ownerIdx: 7 },
      { hash: "0x6f950c918339f0db9831a03c556d33e8940fa9fc6fa8abee490309615a37e544", ownerIdx: 9 },
      { hash: "0x326139b2fc573ef7abf51000cda50acce7a7c5dc1dabe077d25f2bedbd1d69ad", ownerIdx: 4 },
    ],
  },
  {
    label: "Q1",
    qid: "0x93d40ec9afdc436195d5d9022734f3ff8833695a452a0cf65d12673876709d68",
    dbPrizePool: 3450000n,
    // Only rank1 winner payouts. The loser (0x42f77513) gets nothing (their
    // fee_amount was advisory/zero on-chain so no refund leaf).
    recipients: agg([
      // rank1 author 0x483c5106 (idx=1)
      ["0x483c51061e6106fe4e08e138428336a519fc0533", "2415000"],
      // rank1 voters
      ["0x42f77513cbb4c9166e14a1bf703c82d023c2f16c", "345000"],
      ["0x7498bec7b27896c4fa7df254c5ec8a11dd004601", "345000"],
      ["0xf0c36cac44ca127aae7e31c1913afba677e24501", "345000"],
    ]),
    // Q1 loser: sol_d7w04v477njmhne0an30 (author: 0x42f77513, idx=6)
    slashedCommitHashes: [
      "0x7ae0e5b51b20cf13872b7731052b6dbd795449622041eb3a2f7cac5386095be2",
    ],
    slashedVoteHashes: [],
    loserSlashAmount: 1000000n,
    solutionIntents: [
      { hash: "0xc893c7fc45dd4d747b411a1d17d6b26a3521a103aa1ec482096dceaa90b30062", ownerIdx: 1 },
      // loser stake is slashed, not claimable
    ],
    voteIntents: [
      { hash: "0xa74803ee78e4e58ad36bf157a96da3b27e1519cb6db394e560e2643fb04baac5", ownerIdx: 6 },
      { hash: "0x56348f628915186dc00fbb5e71ded33fe6532b642a4e6b1163bdba7ae948ca77", ownerIdx: 4 },
      { hash: "0x4b8bab0a20a0e9189cca1653fe4a9a389b68be3a3e00947bc05d6d80f8e7457b", ownerIdx: 7 },
    ],
  },
];

async function main() {
  if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC not set");

  const oraclePK = derivePrivKey(0);
  const oracle = privateKeyToAccount(oraclePK);
  log("config", `forge=${FORGE} oracle=${oracle.address}`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC),
  });
  const oracleWallet = createWalletClient({
    account: oracle,
    chain: baseSepolia,
    transport: http(RPC),
  });

  for (const q of QUESTIONS) {
    log(q.label, `qid ${q.qid}`);

    // ── Step 1: Read on-chain poolAmount ─────────────────────────────────
    const qState = await publicClient.readContract({
      address: FORGE,
      abi: REZON_FORGE_ABI,
      functionName: "questions",
      args: [q.qid],
    }) as unknown[];
    const onChainPoolAmount = BigInt(qState[15] as string | number | bigint);
    info(`on-chain poolAmount = ${onChainPoolAmount}`);

    // ── Step 2: Compute actual totalClaimable after slash ─────────────────
    const poolAfterSlash = onChainPoolAmount + q.loserSlashAmount;
    info(`poolAfterSlash = ${poolAfterSlash} (bounty ${onChainPoolAmount} + slash ${q.loserSlashAmount})`);

    // ── Step 3: Scale payouts from DB amounts to correct on-chain pool ────
    // All DB payouts sum to dbPrizePool. Scale each by poolAfterSlash/dbPrizePool.
    const dbSum = q.recipients.reduce((a, r) => a + r.dbAmount, 0n);
    info(`DB payout sum = ${dbSum} (prize_pool ${q.dbPrizePool})`);

    const scaledLeaves: MerkleLeaf[] = [];
    let totalClaimable = 0n;
    for (const r of q.recipients) {
      // Scale: scaled = dbAmount * poolAfterSlash / dbPrizePool (integer division)
      const scaledAmt = (r.dbAmount * poolAfterSlash) / q.dbPrizePool;
      if (scaledAmt === 0n) continue;
      scaledLeaves.push({
        questionId: q.qid,
        recipient: r.address,
        amount: scaledAmt,
      });
      totalClaimable += scaledAmt;
      info(`  ${r.address}: ${r.dbAmount} → scaled ${scaledAmt}`);
    }

    const dust = poolAfterSlash - totalClaimable;
    info(`totalClaimable=${totalClaimable} dust=${dust}`);

    // ── Step 4: Build Merkle tree ──────────────────────────────────────────
    const leafHashes = scaledLeaves.map(hashLeaf);
    const levels = buildTreeLevels(leafHashes);
    const root = levels[levels.length - 1][0];
    ok(`merkleRoot ${root}`);

    // Sample proof for first leaf (required by publishSettlement).
    const sampleLeaf = scaledLeaves[0];
    const sampleProof = merkleProof(leafHashes, 0) as Hex[];
    info(`sample recipient ${sampleLeaf.recipient} amount ${sampleLeaf.amount}`);

    // ── Step 5: Sign SettlementIntent ──────────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = BigInt(now + DEFAULT_SETTLEMENT_TTL_SECONDS);
    const td = buildSettlementIntentTypedData({
      forgeAddress: FORGE,
      chainId: CHAIN_ID,
      questionId: q.qid,
      merkleRoot: root,
      totalClaimable,
      sampleRecipient: sampleLeaf.recipient,
      sampleAmount: sampleLeaf.amount,
      sampleProof,
      expiresAtSeconds: Number(expiresAt),
      nowSeconds: now,
    });
    const oracleSig = await oracle.signTypedData(td) as Hex;
    ok(`signed SettlementIntent expiresAt=${expiresAt}`);

    // ── Step 6: Broadcast publishSettlement ────────────────────────────────
    log(`${q.label}:publish`, "broadcasting...");
    const settleTx = await oracleWallet.writeContract({
      address: FORGE,
      abi: REZON_FORGE_ABI,
      functionName: "publishSettlement",
      args: [{
        questionId: q.qid,
        merkleRoot: root,
        totalClaimable,
        sampleRecipient: sampleLeaf.recipient,
        sampleAmount: sampleLeaf.amount,
        sampleProof,
        expiresAt,
        slashedCommitHashes: q.slashedCommitHashes,
        slashedVoteHashes: q.slashedVoteHashes,
      }, oracleSig],
    });
    info(`tx: ${settleTx}`);
    const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleTx });
    ok(`settlement published in block ${settleReceipt.blockNumber} status=${settleReceipt.status}`);

    // ── Step 7: Claim pool payouts for every recipient ─────────────────────
    log(`${q.label}:claim`, "claiming pool payouts...");
    const claimedAddrs = new Set<string>();
    for (let i = 0; i < scaledLeaves.length; i++) {
      const leaf = scaledLeaves[i];
      const proof = merkleProof(leafHashes, i) as Hex[];
      const addrLower = leaf.recipient.toLowerCase();

      // Find which wallet index owns this address.
      let claimerIdx = -1;
      for (let idx = 0; idx <= 10; idx++) {
        if (addrOf(idx).toLowerCase() === addrLower) { claimerIdx = idx; break; }
      }
      if (claimerIdx < 0) {
        warn(`no wallet index for ${leaf.recipient} — skipping claim`);
        continue;
      }
      if (claimedAddrs.has(addrLower)) {
        // Already claimed in this iteration (shouldn't happen with aggregated leaves).
        continue;
      }
      claimedAddrs.add(addrLower);

      const claimerPK = derivePrivKey(claimerIdx);
      const claimerWallet = createWalletClient({
        account: privateKeyToAccount(claimerPK),
        chain: baseSepolia,
        transport: http(RPC),
      });

      const claimTx = await claimerWallet.writeContract({
        address: FORGE,
        abi: REZON_FORGE_ABI,
        functionName: "claim",
        args: [q.qid, leaf.amount, proof],
      });
      await publicClient.waitForTransactionReceipt({ hash: claimTx });
      ok(`claimed ${leaf.amount} for ${leaf.recipient} (idx=${claimerIdx})`);
    }

    // ── Step 8: Claim solution stakes back (winners only; loser slashed) ───
    log(`${q.label}:solutionStakes`, "claiming...");
    for (const si of q.solutionIntents) {
      const claimerWallet = createWalletClient({
        account: privateKeyToAccount(derivePrivKey(si.ownerIdx)),
        chain: baseSepolia,
        transport: http(RPC),
      });
      const tx = await claimerWallet.writeContract({
        address: FORGE,
        abi: REZON_FORGE_ABI,
        functionName: "claimSolutionStake",
        args: [q.qid, si.hash],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      ok(`solution stake claimed idx=${si.ownerIdx}`);
    }

    // ── Step 9: Claim vote stakes back ─────────────────────────────────────
    log(`${q.label}:voteStakes`, "claiming...");
    for (const vi of q.voteIntents) {
      const claimerWallet = createWalletClient({
        account: privateKeyToAccount(derivePrivKey(vi.ownerIdx)),
        chain: baseSepolia,
        transport: http(RPC),
      });
      const tx = await claimerWallet.writeContract({
        address: FORGE,
        abi: REZON_FORGE_ABI,
        functionName: "claimVoteStake",
        args: [q.qid, vi.hash],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      ok(`vote stake claimed idx=${vi.ownerIdx}`);
    }

    console.log("");
    ok(c.bold(`${q.label} COMPLETE — pool claimed ${totalClaimable} USDC (dust ${dust})`));
    console.log("");
  }

  console.log(c.green(c.bold("  Round 5 settle+claim complete.")));
}

main().catch((err) => {
  console.error(`\n\x1b[31m[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
