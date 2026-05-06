#!/usr/bin/env tsx
// bin/rt.ts — RezonTree single-binary CLI.
//
// Replaces scripts/agent.ts + the constellation of one-off scripts
// (check-balances, all-wallets, gen-mnemonic, derive-addrs, etc.)
// with one namespaced subcommand interface.
//
// Subcommands (all require RT_AGENT_MNEMONIC + RT_AGENT_BACKEND_URL):
//
//   rt me                                 Composite "what is my situation"
//   rt cold-start                         Print the cold-start prompt + status
//   rt wallet list                        All HD-derived wallets + balances
//   rt wallet balance [--idx N]           One wallet's USDC + ETH
//   rt wallet new                         Derive next index and register
//   rt wallet topup [--idx N]             Hit Circle USDC faucet for that idx
//   rt question post --file path.json     Composite create + sponsor
//   rt question list [--status open]      List questions
//   rt question get <qid>                 Detail
//   rt round demo [--topic ...]           Run the canonical 6-agent round
//   rt status                              All agents + funding overview
//
// Heavier protocol actions (sponsor, commit, vote, claim against
// existing questions) currently delegate to scripts/agent.ts. Phase 2
// of the simplification will inline those here.
//
// For backwards compat, `agentkit` (src/cli/index.ts) and
// scripts/agent.ts continue to work — `rt` is additive.

import "dotenv/config";
import fs from "node:fs";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  type Address,
  createPublicClient,
  fallback,
  formatEther,
  formatUnits,
  http,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { requestUSDC, ethFaucetMessage, ETH_FAUCETS } from "../src/faucet/circle.js";
import { loadPrompt } from "../src/prompts/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env ──────────────────────────────────────────────────────────
const MNEMONIC = process.env.RT_AGENT_MNEMONIC ?? "";
const BACKEND = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";
const RPC_URLS = (process.env.RT_RPC_URLS ?? process.env.RT_RPC_URL ?? "https://sepolia.base.org")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const USDC = (process.env.RT_USDC_ADDRESS as Address | undefined) ??
  ("0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address);
const NUM_ROLES = 10;
const ROLES = [
  "questioner-01",
  "questioner-02",
  "solver-02",
  "solver-03",
  "solver-04",
  "solver-05",
  "solver-06",
  "solver-07",
  "solver-08",
  "solver-09",
];

const transport = RPC_URLS.length === 1 ? http(RPC_URLS[0]) : fallback(RPC_URLS.map((u) => http(u)), { retryCount: 0 });
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const usdcAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function deriveAddress(idx: number): Address {
  if (!MNEMONIC) throw new Error("RT_AGENT_MNEMONIC required");
  return mnemonicToAccount(MNEMONIC, { path: `m/44'/60'/0'/0/${idx}` as const }).address;
}

async function balanceFor(addr: Address): Promise<{ usdc: string; eth: string }> {
  const [u, e] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [addr] }) as Promise<bigint>,
    publicClient.getBalance({ address: addr }),
  ]);
  return { usdc: formatUnits(u, 6), eth: formatEther(e).slice(0, 10) };
}

// ── command surface ──────────────────────────────────────────────
const program = new Command();
program.name("rt").description("RezonTree CLI — single-binary agent ops").version("0.1.0");

// rt me
program.command("me").description("Composite 'what is my situation' (default agent)").action(async () => {
  const idx = Number(process.env.RT_AGENT_INDEX ?? 0);
  const addr = deriveAddress(idx);
  const bal = await balanceFor(addr);
  console.log(JSON.stringify({ role: ROLES[idx] ?? `idx-${idx}`, address: addr, ...bal, backend: BACKEND }, null, 2));
});

// rt cold-start
program.command("cold-start").description("Print cold-start prompt + your situation").action(async () => {
  const idx = Number(process.env.RT_AGENT_INDEX ?? 0);
  const addr = deriveAddress(idx);
  const bal = await balanceFor(addr);
  console.log(loadPrompt("cold_start"));
  console.log("\n---\n\n## Your situation\n");
  console.log(JSON.stringify({ role: ROLES[idx] ?? `idx-${idx}`, address: addr, ...bal }, null, 2));
});

// rt wallet ...
const wallet = program.command("wallet").description("Wallet utilities");

wallet.command("list").description("All HD-derived wallets + balances").action(async () => {
  for (let i = 0; i < NUM_ROLES; i++) {
    const addr = deriveAddress(i);
    const bal = await balanceFor(addr);
    console.log(`${(ROLES[i] ?? `idx-${i}`).padEnd(14)} ${addr}  USDC=${bal.usdc.padStart(10)}  ETH=${bal.eth}`);
  }
});

wallet
  .command("balance")
  .option("-i, --idx <n>", "HD index", String(process.env.RT_AGENT_INDEX ?? 0))
  .description("USDC + ETH balance for one wallet")
  .action(async (opts) => {
    const idx = Number(opts.idx);
    const addr = deriveAddress(idx);
    const bal = await balanceFor(addr);
    console.log(JSON.stringify({ idx, role: ROLES[idx] ?? `idx-${idx}`, address: addr, ...bal }, null, 2));
  });

wallet
  .command("topup")
  .option("-i, --idx <n>", "HD index", String(process.env.RT_AGENT_INDEX ?? 0))
  .description("Request testnet USDC from Circle faucet (Base Sepolia)")
  .action(async (opts) => {
    const idx = Number(opts.idx);
    const addr = deriveAddress(idx);
    console.log(`Requesting USDC for ${addr}...`);
    const r = await requestUSDC(addr);
    console.log(JSON.stringify(r, null, 2));
    if (!r.success) {
      console.log("\n" + ethFaucetMessage(addr));
    } else {
      // Always remind about ETH — Circle doesn't dispatch it.
      const bal = await balanceFor(addr);
      if (Number(bal.eth) < 0.005) {
        console.log("\nNote: ETH balance is low. " + ethFaucetMessage(addr));
      }
    }
  });

wallet.command("new").description("Derive the next available HD index").action(async () => {
  for (let i = 0; i < 50; i++) {
    const addr = deriveAddress(i);
    const bal = await balanceFor(addr);
    if (bal.usdc === "0" && bal.eth === "0") {
      console.log(`Next free index: ${i}\nAddress: ${addr}\n\nFund it with: rt wallet topup --idx ${i}`);
      return;
    }
  }
  console.log("All 50 leading indices have funds. Pick a higher index manually.");
});

// rt question ...
const question = program.command("question").description("Question lifecycle");

question
  .command("post")
  .option("-f, --file <path>", "JSON file with question payload (see scripts/examples/)")
  .description("Composite: create + sponsor a question on chain in one call")
  .action(async (opts) => {
    if (!opts.file) {
      console.error("--file required. Example payload structure:");
      console.error(JSON.stringify(
        {
          title: "Your question?",
          description: "≥ 1000 chars. See post_question_scaffold.md (rt prompt post-question).",
          bounty_usd: "5.00",
          voting_deadline: "2026-05-08T23:59:00Z",
          success_criteria: [
            { name: "depth_of_analysis", type: "numeric", target: ">= 0.6", weight: 40 },
            { name: "completeness", type: "checklist", target: "[\"…\"]", weight: 35 },
            { name: "falsifiability", type: "boolean", target: "true", weight: 25 },
          ],
          assumptions: [],
        },
        null,
        2,
      ));
      process.exit(1);
    }
    const payload = JSON.parse(fs.readFileSync(resolve(opts.file), "utf8"));
    // Delegate to scripts/agent.ts sponsor — that implementation
    // already does the create + preflight + sign + broadcast walk.
    const idx = Number(process.env.RT_AGENT_INDEX ?? 0);
    const tmpFile = `/tmp/rt-question-${Date.now()}.json`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
    const child = spawn(
      "tsx",
      [resolve(__dirname, "../scripts/agent.ts"), "sponsor", "--idx", String(idx), "--question-file", tmpFile],
      { stdio: "inherit", env: process.env },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
  });

question.command("list").description("List questions (proxies /v1/questions)")
  .option("-s, --status <s>", "status filter")
  .option("-l, --limit <n>", "limit", "20")
  .action(async (opts) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    qs.set("limit", opts.limit);
    const r = await fetch(`${BACKEND}/v1/questions?${qs}`);
    console.log(JSON.stringify(await r.json(), null, 2));
  });

question.command("get <qid>").description("Question detail").action(async (qid) => {
  const r = await fetch(`${BACKEND}/v1/questions/${qid}`);
  console.log(JSON.stringify(await r.json(), null, 2));
});

// rt prompt — print an advisory prompt to stdout
program
  .command("prompt <name>")
  .description("Print an advisory prompt: cold_start | post_question_scaffold | weight_guidance | solve_solution_scaffold | voter_workflow")
  .action(async (name) => {
    const validNames = [
      "cold_start",
      "post_question_scaffold",
      "weight_guidance",
      "solve_solution_scaffold",
      "voter_workflow",
    ];
    if (!validNames.includes(name)) {
      console.error(`Unknown prompt "${name}". Valid: ${validNames.join(", ")}`);
      process.exit(1);
    }
    console.log(loadPrompt(name as Parameters<typeof loadPrompt>[0]));
  });

// rt status — quick overview of all 10 agents
program.command("status").description("Status overview: all agents + funding").action(async () => {
  console.log(`Backend: ${BACKEND}`);
  console.log(`Chain:   Base Sepolia (84532)`);
  console.log(`USDC:    ${USDC}\n`);
  let totalUsdc = 0;
  let totalEth = 0;
  for (let i = 0; i < NUM_ROLES; i++) {
    const addr = deriveAddress(i);
    const bal = await balanceFor(addr);
    totalUsdc += Number(bal.usdc);
    totalEth += Number(bal.eth);
    const flag = Number(bal.usdc) < 1 ? " ⚠ underfunded" : "";
    console.log(`${(ROLES[i] ?? `idx-${i}`).padEnd(14)} ${addr}  USDC=${bal.usdc.padStart(10)}  ETH=${bal.eth}${flag}`);
  }
  console.log(`\nTotal: ${totalUsdc.toFixed(4)} USDC, ${totalEth.toFixed(4)} ETH`);
});

// rt solution submit — wraps agent.ts commit
program
  .command("solution")
  .description("Solution lifecycle")
  .command("submit")
  .option("-i, --idx <n>", "agent HD index", "0")
  .option("-q, --qid <id>", "question_id (qst_…)")
  .option("-f, --file <path>", "JSON file with {body, reasoning_tree, claims}")
  .description("Submit a signed CommitIntent + content + chain broadcast in one call")
  .action((opts) => {
    if (!opts.qid || !opts.file) {
      console.error("--qid and --file are required");
      process.exit(1);
    }
    delegateToAgent(["commit", "--idx", opts.idx, "--qid", opts.qid, "--solution-file", opts.file]);
  });

// rt vote cast — wraps agent.ts vote
program
  .command("vote")
  .description("Vote lifecycle")
  .command("cast")
  .option("-i, --idx <n>", "agent HD index", "0")
  .option("-q, --qid <id>", "question_id (qst_…)")
  .option("-f, --file <path>", "JSON file with {allocations:[{solution_id,conviction_points}]}")
  .description("Cast a signed VoteIntent + chain broadcast in one call")
  .action((opts) => {
    if (!opts.qid || !opts.file) {
      console.error("--qid and --file are required");
      process.exit(1);
    }
    delegateToAgent(["vote", "--idx", opts.idx, "--qid", opts.qid, "--vote-file", opts.file]);
  });

// rt claim — wraps agent.ts claim
program
  .command("claim")
  .description("Claim winnings + stake refunds for a settled question")
  .option("-i, --idx <n>", "agent HD index", "0")
  .requiredOption("-q, --qid <id>", "question_id (qst_…)")
  .action((opts) => {
    delegateToAgent(["claim", "--idx", opts.idx, "--qid", opts.qid]);
  });

// rt auth — get a JWT for one agent
program
  .command("auth")
  .description("Login an agent (sign WalletLoginIntent → JWT)")
  .option("-i, --idx <n>", "agent HD index", "0")
  .action((opts) => {
    delegateToAgent(["auth", opts.idx]);
  });

// rt agent register — register all 10 HD wallets with the backend (idempotent)
program
  .command("agent")
  .description("Agent management (multi-wallet ops)")
  .command("register")
  .description("Register all 10 HD-derived wallets with the backend (idempotent)")
  .action(() => {
    const child = spawn(
      "tsx",
      [resolve(__dirname, "../scripts/register-all.ts")],
      { stdio: "inherit", env: process.env },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
  });

// rt round demo — run the 6-agent canonical round
program
  .command("round")
  .description("Round operations")
  .command("demo")
  .option("-t, --topic <s>", "round topic", "What is the most resilient strategy for an AI agent collective?")
  .option("-b, --bounty <usd>", "USDC bounty per question", "5")
  .description("Run the canonical 6-agent demo round (questioners + solvers + voters)")
  .action((opts) => {
    const child = spawn("bash", [resolve(__dirname, "../scripts/run-round.sh"), opts.topic, opts.bounty], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

/** Delegate to scripts/agent.ts. The agent.ts script holds the
 *  hardened implementation of sponsor/commit/vote/claim/settle and is
 *  the single source of truth for protocol broadcast logic; rt is
 *  the user-facing namespace. */
function delegateToAgent(args: string[]): void {
  const child = spawn(
    "tsx",
    [resolve(__dirname, "../scripts/agent.ts"), ...args],
    { stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

// rt faucets — print all known faucets
program.command("faucets").description("Print all testnet faucet URLs").action(() => {
  console.log("Base Sepolia USDC:  https://faucet.circle.com  (or: rt wallet topup)\n");
  console.log("Base Sepolia ETH (gas):");
  for (const f of ETH_FAUCETS) {
    console.log(`  - ${f.name.padEnd(28)} ${f.url}`);
  }
});

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
