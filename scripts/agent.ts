#!/usr/bin/env tsx
// scripts/agent.ts — one action, one agent, one decision.
//
// This is NOT a battle harness. There are no loops, no scenario lists,
// no orchestration. Each command performs a single deliberate action
// by a single named agent (HD index). Use it the way an agent would
// reason about its own next move: "I'm alice, I want to sponsor this
// question — call agent.ts sponsor --idx 1 --question-file ...".
//
// Subcommands:
//   auth     <idx>                                — login, print JWT
//   sponsor  <idx> --question-file path.json     — post + fund a question
//   commit   <idx> --qid ... --solution-file p   — author + commit a solution
//   vote     <idx> --qid ... --vote-file p       — cast a conviction allocation
//   claim    <idx> --qid ...                     — claim winnings + stake refunds
//   status                                        — current agent set + balances
//
// All actions use the API + chain. No direct DB writes.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  keccak256,
  toBytes,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { signWalletLoginIntent } from "../src/wallet/signer.js";
import { loadLoginDomain } from "../src/wallet/domain.js";
import {
  buildSponsorIntentTypedData,
  buildSponsorFundRequestBody,
  parseAmountToWei,
} from "../src/intents/sponsor-intent.js";
import { broadcastSponsor } from "../src/forge/client.js";
import { signUSDCPermit } from "../src/forge/permit.js";

// ── env + clients ────────────────────────────────────────────────
const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const BACKEND = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";
const FORGE = process.env.RT_FORGE_ADDRESS as Address;
const USDC = (process.env.RT_USDC_ADDRESS as Address) ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
if (!FORGE) throw new Error("RT_FORGE_ADDRESS required");
if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

const CONSUMED_NONCES_ABI = [
  {
    type: "function",
    name: "consumedNonces",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Read the lowest unused nonce for `signer` directly from the chain.
 *  The backend's preflight returns its DB-derived nonce_next, which
 *  desyncs after a DB reset while the chain remembers consumed
 *  nonces forever. Always source-of-truth nonces from chain. */
async function chainNextUnusedNonce(signer: Address): Promise<bigint> {
  for (let word = 0n; word < 100n; word++) {
    const bitmap = (await publicClient.readContract({
      address: FORGE,
      abi: CONSUMED_NONCES_ABI,
      functionName: "consumedNonces",
      args: [signer, word],
    })) as bigint;
    const FULL = (1n << 256n) - 1n;
    if (bitmap === FULL) continue;
    for (let i = 0n; i < 256n; i++) {
      if (((bitmap >> i) & 1n) === 0n) return word * 256n + i;
    }
  }
  throw new Error(`no unused nonce found for ${signer} (impossibly hot wallet)`);
}

// ── helpers ──────────────────────────────────────────────────────

function makeAgent(idx: number): { address: Address; privateKey: Hex; account: ReturnType<typeof mnemonicToAccount> } {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: idx });
  // viem doesn't expose private key directly from mnemonicToAccount;
  // derive it ourselves via getHdKey
  const hdKey = account.getHdKey();
  const pk = ("0x" + Buffer.from(hdKey.privateKey!).toString("hex")) as Hex;
  return { address: account.address.toLowerCase() as Address, privateKey: pk, account };
}

function makeWalletClient(idx: number) {
  const { privateKey } = makeAgent(idx);
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: baseSepolia,
    transport: http(RPC),
  });
}

async function callAPI<T = unknown>(
  method: "GET" | "POST",
  pathStr: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const r = await fetch(`${BACKEND}${pathStr}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!r.ok) {
    throw new Error(`${method} ${pathStr} → ${r.status} ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function login(idx: number): Promise<{ token: string; address: Address }> {
  const { address, privateKey } = makeAgent(idx);
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min
  const domain = loadLoginDomain();
  const signed = await signWalletLoginIntent({
    wallet: {
      agentIndex: idx,
      address,
      privateKey,
      chainId: domain.chainId,
    },
    expiresAt,
    domain,
  });
  const r = await callAPI<{ access_token: string; address: string }>(
    "POST",
    "/auth/wallet",
    { address, chain_id: domain.chainId, expires_at: expiresAt, signature: signed.signature },
  );
  return { token: r.access_token, address: address };
}

async function awaitReceipt(hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`tx ${hash} reverted (status=${receipt.status})`);
  }
}

// ── commands ─────────────────────────────────────────────────────

const program = new Command();
program.name("agent").description("One action, one agent, one decision.");

program
  .command("auth")
  .argument("<idx>", "HD index", (s) => Number.parseInt(s, 10))
  .description("Authenticate as agent <idx> and print JWT.")
  .action(async (idx: number) => {
    const { token, address } = await login(idx);
    console.log(JSON.stringify({ idx, address, token }, null, 2));
  });

program
  .command("sponsor")
  .description("Post + fund a question on chain. Reads question content from --question-file.")
  .requiredOption("--idx <n>", "HD index of the sponsor wallet", (s) => Number.parseInt(s, 10))
  .requiredOption("--question-file <path>", "Path to JSON with title/description/success_criteria")
  .option("--amount <usdc>", "Sponsor amount in USDC (default 1)", "1")
  .action(async (opts) => {
    const idx = opts.idx as number;
    const file = path.resolve(opts.questionFile as string);
    const q = JSON.parse(fs.readFileSync(file, "utf8")) as {
      title: string;
      description: string;
      success_criteria: Array<{ name: string; type: string; target: string; weight: number; description?: string }>;
    };
    console.log(`[agent ${idx}] login...`);
    const me = await login(idx);
    console.log(`  authed as ${me.address}`);

    console.log(`[agent ${idx}] POST /v1/questions ...`);
    const created = await callAPI<{ id: string }>(
      "POST",
      "/v1/questions",
      {
        title: q.title,
        description: q.description,
        success_criteria: q.success_criteria.map((sc) => ({
          name: sc.name,
          type: sc.type,
          target: sc.target,
          weight: sc.weight,
        })),
        initial_bounty: "0",
      },
      me.token,
    );
    console.log(`  question_id=${created.id}`);

    console.log(`[agent ${idx}] GET fund/preflight ...`);
    const pre = await callAPI<{
      mode: string;
      qid: string;
      token: { address: string; decimals: number };
      forge_address: string;
      oracle: string;
      [k: string]: unknown;
    }>("GET", `/v1/questions/${created.id}/fund/preflight?funder=${me.address}`);
    if (pre.mode !== "sponsor") {
      throw new Error(`preflight mode=${pre.mode}, expected sponsor`);
    }
    console.log(`  preflight ok (mode=${pre.mode}, qid=${pre.qid})`);

    const amountWei = parseAmountToWei(opts.amount as string, pre.token.decimals);

    console.log(`[agent ${idx}] sign SponsorIntent ...`);
    // The contract guard requires a non-empty feeShares array even
    // when feeShareBps=0 (the array shape is hashed into the EIP-712
    // digest). Route to the configured platform fee wallet — index 3
    // (carol) in our pool, matching the existing battle harness.
    const feeWalletIdx = Number.parseInt(process.env.RT_FEE_WALLET_IDX ?? "3", 10);
    const feeWallet = makeAgent(feeWalletIdx).address;

    // Read nonce from chain (backend preflight's DB nonce desyncs
    // after a DB reset; chain bitmap is the source of truth).
    const chainNonce = await chainNextUnusedNonce(me.address);
    console.log(`  chain says next unused nonce = ${chainNonce}`);

    const td = buildSponsorIntentTypedData({
      preflight: pre as never,
      sponsor: me.address,
      amountWei,
      feeShareBps: 0n,
      feeShares: [{ recipient: feeWallet, basisPoints: 10000n }],
      nonce: chainNonce,
    });
    const wallet = makeWalletClient(idx);
    const intentSig = (await wallet.account.signTypedData(td)) as Hex;

    console.log(`[agent ${idx}] POST /v1/questions/${created.id}/fund (intent + body) ...`);
    const fundResp = await callAPI<{ contribution_id: string }>(
      "POST",
      `/v1/questions/${created.id}/fund`,
      buildSponsorFundRequestBody({ typedData: td, signature: intentSig }),
      me.token,
    );
    console.log(`  contribution_id=${fundResp.contribution_id}`);

    console.log(`[agent ${idx}] sign USDC permit ...`);
    const permit = await signUSDCPermit(wallet, publicClient, {
      usdc: USDC,
      spender: FORGE,
      value: amountWei,
      deadline: td.message.expiresAt,
    });

    console.log(`[agent ${idx}] broadcast sponsor() on chain ...`);
    const tx = await broadcastSponsor(wallet, {
      forgeAddress: FORGE,
      intent: td.message,
      intentSig,
      permit,
    });
    console.log(`  tx=${tx}`);
    await awaitReceipt(tx);
    console.log(`  receipt status=success`);

    console.log("\n=== Sponsor action complete ===");
    console.log(JSON.stringify({
      agent: { idx, address: me.address },
      question_id: created.id,
      qid: pre.qid,
      contribution_id: fundResp.contribution_id,
      amount_usdc: opts.amount,
      tx,
    }, null, 2));
  });

program
  .command("status")
  .description("Show registered agents + balances.")
  .action(async () => {
    const ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
    console.log("idx | address                                    | ETH    | USDC");
    console.log("----+--------------------------------------------+--------+-------");
    for (let i = 0; i <= 10; i++) {
      const { address } = makeAgent(i);
      const [eth, usdc] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.readContract({ address: USDC, abi: ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      ]);
      console.log(`${String(i).padStart(3)} | ${address} | ${formatUnits(eth, 18).slice(0, 6)} | ${formatUnits(usdc, 6).padStart(5)}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
