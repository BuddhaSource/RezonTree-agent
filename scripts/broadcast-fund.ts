#!/usr/bin/env tsx
// broadcast-fund.ts — single-wallet end-to-end Sponsor/Cosponsor closure
// (v2.5).
//
// Closes fund-lock through indexer ingestion:
//   1. Derive one wallet from RT_AGENT_MNEMONIC (path 0/0).
//   2. POST /auth/wallet + POST /v1/problems (backend row created).
//   3. GET /fund/preflight, sign Sponsor or Cosponsor intent, POST /fund.
//   4. Sign USDC permit, call RezonForge.sponsor() / cosponsor() on
//      chain, wait receipt.
//   5. Poll Postgres for contribution.confirmation_status = confirmed.
//
// This is a bring-up script, not a primitive — lives in scripts/,
// not src/.
//
// Required env:
//   RT_AGENT_MNEMONIC        — mnemonic of a funded Base Sepolia wallet
//   RT_ROUTER_ADDRESS        — deployed RezonForge address
//   RT_USDC_ADDRESS          — canonical USDC address (Base Sepolia default below)
//   RT_BACKEND_URL           — defaults to http://localhost:8080
//   RT_RPC_URL               — defaults to https://sepolia.base.org
//   RT_AGENT_DOMAIN_VERIFYING_CONTRACT — wallet-login domain contract.

import { execSync } from "node:child_process";
import type { Hex } from "viem";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAgentWallet } from "../src/wallet/derive.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { defaultFeeSharePolicy } from "../src/intents/fee-share.js";
import {
  buildSponsorFundRequestBody,
  buildSponsorIntentTypedData,
  parseAmountToWei,
} from "../src/intents/sponsor-intent.js";
import {
  buildCosponsorFundRequestBody,
  buildCosponsorIntentTypedData,
} from "../src/intents/cosponsor-intent.js";
import type { FundPreflight } from "../src/intents/preflight-types.js";
import {
  awaitReceipt,
  broadcastCosponsor,
  broadcastSponsor,
  makeAgentWalletClient,
} from "../src/forge/client.js";
import { signUSDCPermit } from "../src/forge/permit.js";

const BACKEND = process.env.RT_BACKEND_URL ?? "http://localhost:8080";
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = 84532;
const USDC =
  (process.env.RT_USDC_ADDRESS as `0x${string}`) ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROUTER = process.env.RT_ROUTER_ADDRESS as `0x${string}` | undefined;
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;

if (!ROUTER) throw new Error("RT_ROUTER_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const log = (step: string, detail?: string) =>
  console.log(`${c.cyan(`[${step}]`)}${detail ? ` ${detail}` : ""}`);
const ok = (d: string) => console.log(`  ${c.green("✓")} ${d}`);
const info = (d: string) => console.log(`  ${c.dim(d)}`);

async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = raw;
  }
  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; action?: string } }).error;
    throw new Error(
      `${method} ${path} → ${res.status}: ${err?.message ?? raw}${err?.action ? ` — ${err.action}` : ""}`,
    );
  }
  return parsed as T;
}

async function main() {
  log("broadcast-fund", c.bold(`backend ${BACKEND} | router ${ROUTER}`));

  // Step 1 — derive the funded operator wallet.
  const wallet = deriveAgentWallet(MNEMONIC!, 0, CHAIN_ID);
  ok(`wallet ${wallet.address}`);

  // Step 2 — login.
  log("1/6", "wallet login");
  const loginBody = await signWalletLoginIntent({
    wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    domain: loadLoginDomain(),
  });
  const loginResp = await call<{ access_token: string }>(
    "POST",
    "/auth/wallet",
    loginBody,
  );
  const token = loginResp.access_token;
  ok("JWT acquired");

  // Step 3 — create a problem.
  log("2/6", "create problem");
  const problem = await call<{ id: string }>(
    "POST",
    "/v1/problems",
    {
      title: `Broadcast sim ${Date.now()}`,
      description: "End-to-end fund broadcast bring-up.",
      success_criteria: [
        { name: "primary", type: "boolean", target: "true", weight: 100 },
      ],
      initial_bounty: "0",
    },
    token,
  );
  ok(`problem ${problem.id}`);

  // Step 4 — preflight + sign Sponsor/Cosponsor intent + POST /fund.
  log("3/6", "sign Sponsor/Cosponsor intent + POST /fund");
  const pre = await call<FundPreflight>(
    "GET",
    `/v1/problems/${problem.id}/fund/preflight?funder=${wallet.address}`,
  );
  info(`preflight qid ${pre.qid.slice(0, 10)}… nonce_next ${pre.nonce_next}`);

  const amountWei = parseAmountToWei("1", pre.token.decimals); // min L2 bounty
  info(`preflight mode=${pre.mode}`);

  // Default fee-share policy: 1 bps + 100% to self. Smallest chain-valid
  // shape (RezonForge.sol rejects empty fee-share arrays unconditionally).
  const policy = defaultFeeSharePolicy(wallet.address);

  const fundAccount = privateKeyToAccount(wallet.privateKey);
  let fundSig: Hex;
  let fundBody:
    | ReturnType<typeof buildSponsorFundRequestBody>
    | ReturnType<typeof buildCosponsorFundRequestBody>;
  let intentMessageForBroadcast:
    | { mode: "sponsor"; td: ReturnType<typeof buildSponsorIntentTypedData> }
    | {
        mode: "cosponsor";
        td: ReturnType<typeof buildCosponsorIntentTypedData>;
      };
  let permitDeadline: bigint;

  if (pre.mode === "sponsor") {
    const td = buildSponsorIntentTypedData({
      preflight: pre,
      sponsor: wallet.address,
      amountWei,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
    });
    fundSig = (await fundAccount.signTypedData(td)) as Hex;
    fundBody = buildSponsorFundRequestBody({ typedData: td, signature: fundSig });
    intentMessageForBroadcast = { mode: "sponsor", td };
    permitDeadline = td.message.expiresAt;
  } else {
    const td = buildCosponsorIntentTypedData({
      preflight: pre,
      sponsor: wallet.address,
      amountWei,
      feeShareBps: policy.bps,
      feeShares: policy.shares,
    });
    fundSig = (await fundAccount.signTypedData(td)) as Hex;
    fundBody = buildCosponsorFundRequestBody({
      typedData: td,
      signature: fundSig,
    });
    intentMessageForBroadcast = { mode: "cosponsor", td };
    permitDeadline = td.message.expiresAt;
  }

  const fundResp = await call<{ intent_hash: string; contribution_id: string }>(
    "POST",
    `/v1/problems/${problem.id}/fund`,
    fundBody,
    token,
  );
  ok(`backend row ${fundResp.contribution_id} intent ${fundResp.intent_hash.slice(0, 10)}…`);

  // Step 5 — USDC permit + RezonForge.sponsor() / cosponsor() on-chain.
  log("4/6", "sign USDC permit");
  const walletClient = makeAgentWalletClient({
    privateKey: wallet.privateKey,
    chainId: CHAIN_ID,
    rpcUrl: RPC,
  });
  const publicClient = createPublicClient({
    chain: walletClient.chain,
    transport: http(RPC),
  });
  const permit = await signUSDCPermit(walletClient, publicClient, {
    usdc: USDC,
    spender: ROUTER!,
    value: amountWei,
    deadline: permitDeadline,
  });
  ok(`permit v=${permit.v} r=${permit.r.slice(0, 10)}… deadline=${permit.deadline}`);

  log(
    "5/6",
    `broadcast RezonForge.${intentMessageForBroadcast.mode === "sponsor" ? "sponsor" : "cosponsor"}()`,
  );
  const txHash =
    intentMessageForBroadcast.mode === "sponsor"
      ? await broadcastSponsor(walletClient, {
          routerAddress: ROUTER!,
          intent: intentMessageForBroadcast.td.message,
          intentSig: fundSig,
          permit,
        })
      : await broadcastCosponsor(walletClient, {
          routerAddress: ROUTER!,
          intent: intentMessageForBroadcast.td.message,
          intentSig: fundSig,
          permit,
        });
  info(`tx ${txHash}`);
  await awaitReceipt(publicClient, txHash);
  ok("tx confirmed");

  // Step 6 — poll backend DB for contribution row to flip confirmed.
  log("6/6", "poll for indexer ingestion");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const out = execSync(
        `docker exec rezontree-postgres-1 psql -U rezontree -d rezontree -Atc "SELECT confirmation_status FROM contributions WHERE id = '${fundResp.contribution_id}'"`,
        { encoding: "utf-8" },
      ).trim();
      info(`  [${i + 1}/40] status=${out}`);
      if (out === "confirmed") {
        ok(`contribution ${fundResp.contribution_id} → confirmed`);
        console.log("");
        console.log(c.green(c.bold("  Fund-lock end-to-end: passing.")));
        return;
      }
    } catch (err) {
      info(`  poll error: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  throw new Error("Contribution row did not flip to confirmed within timeout.");
}

main().catch((err) => {
  console.error(c.red(`\n[FAIL] ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});
