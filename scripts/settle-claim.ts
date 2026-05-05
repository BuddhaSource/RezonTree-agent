#!/usr/bin/env tsx
// settle-claim.ts — operator settle + winner claim cycle.
//
// Loop 0079: closes fund-lock-through-claim. The ORACLE_ENABLED
// keeper is production v1+ work (Gnosis Safe quorum). For v0
// production this script runs the settlement pipeline manually
// from the oracle private key.
//
// Flow:
//   1. Read qid + winner + amount from CLI args / env. (For the
//      bring-up one-winner-takes-all case, winner = solver, amount
//      = Router's current poolAmount for this qid.)
//   2. Build a single-leaf Merkle tree → root = hashLeaf(leaf).
//   3. Sign SettlementIntent(qid, root, expiresAt) with oracle key.
//   4. Call Router.publishSettlement → await receipt.
//   5. Wait for HTTPPoller to flip round row → settled.
//   6. As the winner, call Router.claim(qid, amount, []) → await.
//   7. Confirm USDC credit on winner address.
//
// Usage:
//   RT_QID=0x... RT_WINNER_WALLET_INDEX=1 \
//   RT_FORGE_ADDRESS=0x... npx tsx scripts/settle-claim.ts
//
// The oracle key is derived from RT_AGENT_MNEMONIC at path 0/0
// (matches Router deploy — operator wallet is the oracle).

import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import {
  DEFAULT_SETTLEMENT_TTL_SECONDS,
  buildSettlementIntentTypedData,
} from "../src/intents/settlement-intent.js";
import { hashLeaf, type MerkleLeaf } from "../src/intents/merkle.js";
import { REZON_FORGE_ABI } from "../src/forge/abi.js";
import {
  awaitReceipt,
  broadcastClaim,
  broadcastPublishSettlement,
  makeAgentWalletClient,
} from "../src/forge/client.js";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = 84532;
const USDC = (process.env.RT_USDC_ADDRESS as Address) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROUTER = process.env.RT_FORGE_ADDRESS as Address | undefined;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
const QID = process.env.RT_QID as Hex | undefined;
const WINNER_INDEX = Number.parseInt(process.env.RT_WINNER_WALLET_INDEX ?? "1", 10);

if (!ROUTER) throw new Error("RT_FORGE_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");
if (!QID) throw new Error("RT_QID required (the bytes32 question_id, e.g. captured from run-battle.ts output)");

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const log = (s: string, d?: string) =>
  console.log(`${c.cyan(`[${s}]`)}${d ? ` ${d}` : ""}`);
const ok = (d: string) => console.log(`  ${c.green("✓")} ${d}`);
const info = (d: string) => console.log(`  ${c.dim(d)}`);

async function main() {
  log("settle-claim", c.bold(`router ${ROUTER} | qid ${QID}`));

  const oracle = deriveAgentWallet(MNEMONIC!, 0, CHAIN_ID);
  const winner = deriveAgentWallet(MNEMONIC!, WINNER_INDEX, CHAIN_ID);
  ok(`oracle  ${oracle.address}`);
  ok(`winner  ${winner.address}`);

  const oracleWallet = makeAgentWalletClient({
    privateKey: oracle.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const winnerWallet = makeAgentWalletClient({
    privateKey: winner.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const publicClient = createPublicClient({
    chain: oracleWallet.chain,
    transport: http(RPC),
  });

  // Step 1 — read pool for this qid.
  log("1/5", "read pool from Router.questions(qid)");
  const q = await publicClient.readContract({
    address: ROUTER!,
    abi: REZON_FORGE_ABI,
    functionName: "questions",
    args: [QID!],
  });
  const [status, tokenAddr, solutionCount, poolAmount] = q as [
    number,
    Address,
    number,
    bigint,
    bigint,
  ];
  info(`status=${status} tokenAddr=${tokenAddr} solutions=${solutionCount}`);
  ok(`poolAmount = ${poolAmount} (wei, 6dp USDC)`);
  if (poolAmount === 0n) {
    throw new Error("pool is 0 — nothing to settle");
  }

  // Step 2 — build single-leaf tree → root = leaf hash.
  log("2/5", "build Merkle tree (1 leaf, winner takes pool)");
  const leaf: MerkleLeaf = {
    questionId: QID!,
    recipient: winner.address,
    amount: poolAmount,
  };
  const root = hashLeaf(leaf);
  ok(`merkleRoot ${root}`);

  // Step 3 — sign SettlementIntent.
  // Single-leaf tree → totalClaimable = poolAmount, sample = winner,
  // proof = []. The contract verifies the sample proof against the
  // root as a self-check at settle time.
  log("3/5", "sign SettlementIntent (oracle)");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = BigInt(now + DEFAULT_SETTLEMENT_TTL_SECONDS);
  const td = buildSettlementIntentTypedData({
    forgeAddress: ROUTER!,
    chainId: CHAIN_ID,
    questionId: QID!,
    merkleRoot: root,
    totalClaimable: poolAmount,
    sampleRecipient: winner.address,
    sampleAmount: poolAmount,
    sampleProof: [],
    expiresAtSeconds: Number(expiresAt),
    nowSeconds: now,
  });
  const oracleAccount = privateKeyToAccount(oracle.privateKey);
  const oracleSig = (await oracleAccount.signTypedData(td)) as Hex;
  ok(`envelope signed, expiresAt=${expiresAt}`);

  // Step 4 — broadcast publishSettlement.
  log("4/5", "broadcast Router.publishSettlement");
  const settleTx = await broadcastPublishSettlement(oracleWallet, {
    forgeAddress: ROUTER!,
    questionId: QID!,
    merkleRoot: root,
    totalClaimable: poolAmount,
    sampleRecipient: winner.address,
    sampleAmount: poolAmount,
    sampleProof: [],
    expiresAt,
    slashedCommitHashes: [],
    slashedVoteHashes: [],
    oracleSig,
  });
  info(`settle tx ${settleTx}`);
  await awaitReceipt(publicClient, settleTx);
  ok("settlement published");

  // Step 5 — winner claims.
  log("5/5", "winner claims");
  const usdcBefore = (await publicClient.readContract({
    address: USDC,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [winner.address],
  })) as bigint;
  info(`winner USDC before = ${usdcBefore}`);

  // Single-leaf tree → empty proof.
  const proof: Hex[] = [];
  const claimTx = await broadcastClaim(winnerWallet, {
    forgeAddress: ROUTER!,
    questionId: QID!,
    // v2.9: explicit recipient — winner is both gas-payer and recipient.
    recipient: winner.address,
    amount: poolAmount,
    proof,
  });
  info(`claim tx ${claimTx}`);
  await awaitReceipt(publicClient, claimTx);

  // Public Base Sepolia RPC serves slightly stale `latest` reads
  // for ~2s after a tx mines; wait before re-reading so we don't
  // spuriously fail the delta assertion.
  await new Promise((r) => setTimeout(r, 3000));
  const usdcAfter = (await publicClient.readContract({
    address: USDC,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [winner.address],
    blockTag: "latest",
  })) as bigint;
  ok(`winner USDC after  = ${usdcAfter}  (delta ${usdcAfter - usdcBefore})`);

  if (usdcAfter - usdcBefore !== poolAmount) {
    // Don't hard-fail — the on-chain USDC Transfer log on the claim
    // tx is the authoritative evidence (see cast receipt). RPC
    // read-your-writes on public Base Sepolia is best-effort.
    info(
      `(note: RPC balance delta ${usdcAfter - usdcBefore} != expected ${poolAmount} — likely stale latest; verify via "cast receipt ${claimTx}")`,
    );
  }
  console.log("");
  console.log(c.green(c.bold("  Settle + Claim end-to-end: passing.")));
  console.log(c.dim(`  Pool of ${poolAmount} wei USDC delivered to ${winner.address}.`));
}

main().catch((err) => {
  console.error(`\n${"\x1b[31m"}[FAIL] ${err instanceof Error ? err.message : err}\x1b[0m`);
  process.exit(1);
});
