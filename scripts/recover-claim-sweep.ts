#!/usr/bin/env tsx
/**
 * recover-claim-sweep.ts — one-shot claim sweeper for the post-ForgeBadSigner
 * recovery batch. Uses the public /v1/wallet-claims batch endpoint so the
 * backend serves canonical proofs (no local merkle math needed).
 *
 * Usage:
 *   RT_AGENT_MNEMONIC=... RT_FORGE_ADDRESS=0x... npx tsx scripts/recover-claim-sweep.ts qst_aaa qst_bbb ...
 *   # or omit qids to scan all settled questions:
 *   npx tsx scripts/recover-claim-sweep.ts
 *
 * Env (defaults in []):
 *   RT_AGENT_MNEMONIC   required
 *   RT_FORGE_ADDRESS    required
 *   RT_RPC_URL          [https://sepolia.base.org]
 *   RT_CHAIN_ID         [84532]
 *   RT_API_BASE         [http://localhost:8080]
 *   RT_WALLET_BANK_SIZE [30]
 *   RT_DRY_RUN          [0]   "1" to skip broadcast
 */
import { createPublicClient, http, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { makeAgentWalletClient, broadcastClaim } from "../src/forge/client.js";

interface ClaimItem {
  address: string;
  questionId: string;
  qid: string;
  role: string;
  status: string;
  amount: string;
  merkleRoot: string;
  proof: string[];
  chainId: number;
  forgeAddress: string;
}

interface BatchResponse {
  claims: ClaimItem[];
  summary: {
    tokens: Array<{ symbol: string; decimals: number; totalClaimable: string; totalClaimed: string; count: number }>;
    claimCount: number;
    claimedCount: number;
  };
  addressesQueried: string[];
  warnings?: Array<{ qid: string; reason: string; desc: string }>;
}

function deriveBank(mnemonic: string, size: number): Map<string, { idx: number; pk: Hex; address: Address }> {
  const bank = new Map<string, { idx: number; pk: Hex; address: Address }>();
  for (let i = 0; i < size; i++) {
    const acct = mnemonicToAccount(mnemonic, { path: `m/44'/60'/0'/0/${i}` as const });
    const pk = acct.getHdKey().privateKey;
    if (!pk) continue;
    bank.set(acct.address.toLowerCase(), {
      idx: i,
      pk: `0x${Buffer.from(pk).toString("hex")}` as Hex,
      address: acct.address as Address,
    });
  }
  return bank;
}

async function main() {
  const qids = process.argv.slice(2).filter((s) => s.startsWith("qst_"));
  const mnemonic = process.env.RT_AGENT_MNEMONIC;
  const forge = process.env.RT_FORGE_ADDRESS;
  if (!mnemonic || !forge) {
    console.error("RT_AGENT_MNEMONIC and RT_FORGE_ADDRESS required");
    process.exit(2);
  }
  const apiBase = (process.env.RT_API_BASE ?? "http://localhost:8080").replace(/\/$/, "");
  const rpcUrl = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
  const chainId = Number(process.env.RT_CHAIN_ID ?? "84532");
  const bankSize = Number(process.env.RT_WALLET_BANK_SIZE ?? "30");
  const dryRun = process.env.RT_DRY_RUN === "1";

  const bank = deriveBank(mnemonic, bankSize);
  const allAddresses = [...bank.values()].map((w) => w.address);

  // Backend caps addresses at 20 per call; chunk the bank.
  const ADDR_CAP = 20;
  const chunks: Address[][] = [];
  for (let i = 0; i < allAddresses.length; i += ADDR_CAP) {
    chunks.push(allAddresses.slice(i, i + ADDR_CAP));
  }

  // Convert qst_ ids to bytes32 once.
  let qidsParam = "";
  if (qids.length > 0) {
    const qidHexes: string[] = [];
    for (const id of qids) {
      const r = await fetch(`${apiBase}/v1/questions/${id}/settlement`);
      if (!r.ok) continue;
      const m = (await r.json()) as { qid: string };
      if (m.qid) qidHexes.push(m.qid);
    }
    if (qidHexes.length > 0) qidsParam = qidHexes.join(",");
  }

  const allClaims: ClaimItem[] = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams();
    params.set("addresses", chunk.join(","));
    if (qidsParam) params.set("qids", qidsParam);
    const url = `${apiBase}/v1/wallet-claims?${params.toString()}`;
    console.log(`[sweep] GET … addrs=${chunk.length} qids=${qids.length || "all"}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Backend ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const data = (await res.json()) as BatchResponse;
    allClaims.push(...data.claims);
    for (const w of data.warnings ?? []) console.warn(`  warn ${w.qid}: ${w.reason}`);
  }
  const data: BatchResponse = {
    claims: allClaims,
    summary: { tokens: [], claimCount: allClaims.length, claimedCount: 0 },
    addressesQueried: allAddresses,
  };
  console.log(`[manifest] ${data.claims.length} claimable rows across ${chunks.length} chunks · dryRun=${dryRun}`);

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  let attempts = 0;
  let claimed = 0n;
  let alreadyClaimed = 0;
  let failed = 0;

  for (const item of data.claims) {
    const w = bank.get(item.address.toLowerCase());
    if (!w) continue; // shouldn't happen — we asked for these addresses
    attempts++;
    if (dryRun) {
      console.log(`  DRY claim ${item.amount} → ${item.address} qid=${item.qid.slice(0, 12)}… idx=${w.idx} proofLen=${item.proof.length}`);
      continue;
    }
    try {
      const wallet = makeAgentWalletClient({ privateKey: w.pk, chainId, rpcUrl });
      const tx = await broadcastClaim(wallet, {
        forgeAddress: forge as Address,
        questionId: item.qid as Hex,
        recipient: item.address as Address,
        amount: item.amount,
        proof: item.proof as Hex[],
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
      if (rcpt.status === "success") {
        console.log(`  ✓ claim ${item.amount} → ${item.address} qid=${item.qid.slice(0, 12)}… tx=${tx}`);
        claimed += BigInt(item.amount);
      } else {
        console.log(`  ✗ revert ${item.address} qid=${item.qid.slice(0, 12)}… tx=${tx}`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/AlreadyClaimed|already.?claimed/i.test(msg)) {
        console.log(`  ~ already claimed ${item.address} qid=${item.qid.slice(0, 12)}…`);
        alreadyClaimed++;
      } else {
        console.warn(`  ✗ ${item.address}: ${msg.split("\n")[0].slice(0, 200)}`);
        failed++;
      }
    }
  }

  console.log(`\n[done] attempts=${attempts} claimed=${claimed} alreadyClaimed=${alreadyClaimed} failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
