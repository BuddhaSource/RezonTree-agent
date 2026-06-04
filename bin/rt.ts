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
// `rt` is the CLI entry. The old `agentkit` framework CLI was removed with the
// AgentKit framework; the protocol broadcast core lives in scripts/agent.ts.

import "dotenv/config";
import fs from "node:fs";
import { Command } from "commander";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { base, baseSepolia } from "viem/chains";

import { requestUSDC, ethFaucetMessage, ETH_FAUCETS } from "../src/faucet/circle.js";
import { loadPrompt } from "../src/prompts/index.js";
import { renderCatalog } from "../src/catalog/index.js";
import { scaffold, type ScaffoldKind } from "../src/bootstrap/scaffold.js";
import {
  ensureResourceDirs,
  listResources,
  resourceRoot,
  RESOURCE_CATEGORIES,
} from "../src/resources/index.js";
import {
  runOnboard,
  renderOnboardPlan,
  type Blend,
  type OnboardAnswers,
} from "../src/bootstrap/onboard.js";
import { selectPredictionQuestions } from "../src/markets/prediction-question.js";
import { polymarketSource } from "../src/markets/polymarket.js";
import { loginWallet } from "../src/wallet/login.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

/** Installed SDK version, read from package.json (the single source). Falls
 *  back to "unknown" if the file can't be read — never throws. */
function installedSdkVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as {
      version?: string;
      name?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Best-effort latest published version via `npm view <pkg> version`. Returns
 *  null on any failure (offline, registry error, timeout) — never throws. */
async function npmLatestVersion(pkg: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", pkg, "version"], {
      timeout: 4000,
      windowsHide: true,
    });
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Best-effort live protocol/skill version from the backend. Tries
 *  GET {backend}/skill.json (`.version`), then GET {backend}/v1/protocol
 *  (probing common version fields). Returns null on any failure — never
 *  throws. A 4s abort keeps an unreachable backend from hanging the CLI. */
async function liveProtocolVersion(
  backend: string,
): Promise<{ version: string; source: string } | null> {
  const probe = async (path: string, fields: string[]): Promise<{ version: string; source: string } | null> => {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      const res = await fetch(`${backend}${path}`, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      for (const f of fields) {
        const v = body[f];
        if (typeof v === "string" && v.length > 0) return { version: v, source: path };
        if (typeof v === "number") return { version: String(v), source: path };
      }
      return null;
    } catch {
      return null;
    }
  };
  return (
    (await probe("/skill.json", ["version", "skillVersion"])) ??
    (await probe("/v1/protocol", ["version", "protocolVersion", "domainVersion", "rev"]))
  );
}

// ── env ──────────────────────────────────────────────────────────
// Production-default: Base mainnet. RT_NETWORK=testnet flips the chain,
// RPC, USDC token, and hosted backend together to Base Sepolia (internal/
// dev only — there is no public testnet).
const IS_MAINNET = process.env.RT_NETWORK !== "testnet";
const CHAIN = IS_MAINNET ? base : baseSepolia;
const DEFAULT_RPC = IS_MAINNET ? "https://mainnet.base.org" : "https://sepolia.base.org";
const DEFAULT_USDC = IS_MAINNET
  ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEFAULT_BACKEND = IS_MAINNET ? "https://api.rezontree.com" : "http://localhost:8080";

const MNEMONIC = process.env.RT_AGENT_MNEMONIC ?? "";
const BACKEND = process.env.RT_AGENT_BACKEND_URL ?? DEFAULT_BACKEND;
const RPC_URLS = (process.env.RT_RPC_URLS ?? process.env.RT_RPC_URL ?? DEFAULT_RPC)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const USDC = (process.env.RT_USDC_ADDRESS as Address | undefined) ??
  (DEFAULT_USDC as Address);
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
const publicClient = createPublicClient({ chain: CHAIN, transport });
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
program.name("rt").description("RezonTree CLI — single-binary agent ops").version(installedSdkVersion());

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
  console.log("\nTip: run `rt doctor` now and then to check for SDK + protocol updates.");
});

program
  .command("catalog")
  .description("Discovery: every action / persona / domain / skill, in one read")
  .action(() => {
    console.log(renderCatalog());
  });

program
  .command("new <kind> [name]")
  .description("Scaffold a private .local card to extend the swarm (kind: agent|skill|voice)")
  .action((kind: string, name?: string) => {
    const s = scaffold(kind as ScaffoldKind, name);
    const abs = resolve(__dirname, "..", s.path);
    if (fs.existsSync(abs)) {
      console.error(`refusing to overwrite ${s.path} — it already exists`);
      process.exit(1);
    }
    fs.writeFileSync(abs, s.content);
    console.log(`created ${s.path}\nEdit THIS file — never the shipped card. It's gitignored (*.local.md) and overrides/extends the shipped set.`);
  });

// rt files — the agent working directory. Scaffolds + lists the merged
// common + per-persona view of tools/ research/ working/.
program
  .command("files [persona]")
  .description("Working directory: scaffold + list tools/research/working (merged common + persona)")
  .action((persona?: string) => {
    const id = persona ?? "generalist";
    ensureResourceDirs(id);
    console.log(`Working directory: ${resourceRoot()}`);
    console.log(`  common/<cat>/          shared by every agent`);
    console.log(`  personas/${id}/<cat>/  this persona only (shadows common)\n`);
    for (const cat of RESOURCE_CATEGORIES) {
      const entries = listResources(id, cat);
      console.log(`  ${cat}/  (${entries.length})`);
      for (const e of entries) {
        const marker = e.scope === "persona" ? "•" : "·";
        console.log(`    ${marker} ${e.name}${e.kind === "dir" ? "/" : ""}`);
      }
    }
    console.log(`\n  · = shared (common)   • = this persona`);
    console.log(`  tools/    download tools/code here (clone a repo, save a script the agent runs)`);
    console.log(`  research/ gathered material   working/ scratch + working files`);
    console.log(`  Drop in common/<cat>/ for all agents, or personas/${id}/<cat>/ for just this one.`);
  });

// rt init — get-started: specialization + team size + persona blend → plan
program
  .command("init")
  .description("Get started: pick specialization, team size, persona blend → launch plan")
  .option("-s, --specialization <id>", "ai-alignment | distributed-systems | mechanism-design | security | general")
  .option("-t, --team <n>", "team size 1-9")
  .option("-b, --blend <blend>", "balanced | research | solve | vote")
  .option("--topics <list>", "| separated topic overrides")
  .option("--budget <usd>", "total USDC spend cap for the run (sets RT_BUDGET_USD); swarm stops when spent down")
  .option("--write <path>", "write the env snippet to a file")
  .action(async (opts) => {
    const flags: Partial<OnboardAnswers> = {};
    if (opts.specialization) flags.specialization = String(opts.specialization);
    if (opts.team) flags.teamSize = Number(opts.team);
    if (opts.blend) flags.blend = String(opts.blend) as Blend;
    if (opts.topics) flags.topics = String(opts.topics).split("|").map((t) => t.trim()).filter(Boolean);
    if (opts.budget !== undefined) flags.budgetUsd = Number(opts.budget);
    const plan = await runOnboard({ flags });
    console.log(renderOnboardPlan(plan));
    if (opts.write) {
      fs.writeFileSync(String(opts.write), plan.envSnippet + "\n");
      console.log(`  env written → ${opts.write}\n`);
    }
    console.log("  Tip: run `rt doctor` now and then to check for SDK + protocol updates.\n");
  });

// rt doctor — check for SDK + protocol updates. Best-effort + dependency-free:
// the SDK version comes from package.json, the latest from `npm view`, and the
// live protocol/skill version from the backend. Every probe swallows its own
// failure into a "couldn't check" line so an offline agent still gets a report.
program
  .command("doctor")
  .alias("update-check")
  .description("Check installed SDK + protocol versions against the latest available")
  .action(async () => {
    const installed = installedSdkVersion();
    console.log("RezonTree doctor — update check\n");

    // 1. SDK version: installed (package.json) vs latest (npm registry).
    const latest = await npmLatestVersion("rezontree-agent");
    if (latest === null) {
      console.log(`  SDK:      ${installed} (couldn't reach npm — offline? skipping latest check)`);
    } else if (latest === installed) {
      console.log(`  SDK:      ${installed} — up to date`);
    } else {
      console.log(`  SDK:      update available: ${installed} → ${latest}  (npm i -g rezontree-agent@latest)`);
    }

    // 2. Protocol/skill version: what the backend is serving right now.
    const live = await liveProtocolVersion(BACKEND);
    if (live === null) {
      console.log(`  Protocol: couldn't reach ${BACKEND} (offline, or backend down) — skipping`);
    } else {
      console.log(`  Protocol: ${live.source} reports version ${live.version} (backend ${BACKEND})`);
    }
    console.log("");
  });

// rt predict — crowdsource a prediction-market outcome's probability
program
  .command("predict")
  .description("Fetch Polymarket markets closing soon → build timed probability question(s) (dry-run by default)")
  .option("--min-hours <n>", "earliest market close, hours from now", "18")
  .option("--max-hours <n>", "latest market close, hours from now", "24")
  .option("-l, --limit <n>", "max markets to build", "1")
  .option("--post", "create the question(s) on the backend (default: print only)")
  .action(async (opts) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const src = polymarketSource(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Polymarket Gamma ${res.status}`);
      return res.json();
    });
    const markets = await src.fetchClosingMarkets({
      nowSec,
      minHours: Number(opts.minHours),
      maxHours: Number(opts.maxHours),
    });
    const picks = selectPredictionQuestions(markets, nowSec, { limit: Number(opts.limit) });
    if (picks.length === 0) {
      console.log(`No Polymarket markets closing in ${opts.minHours}-${opts.maxHours}h. Widen with --max-hours.`);
      return;
    }
    for (const { market, question } of picks) {
      const roundClose = new Date(question.timing.roundClosesAtSec * 1000).toISOString();
      console.log(`\n── ${market.question}`);
      console.log(`   market closes ${new Date(market.closesAt * 1000).toISOString()} | round should close by ${roundClose}`);
      console.log(`   title:    ${question.title}`);
      console.log(`   criteria: ${question.successCriteria.map((c) => `${c.name}(${c.weight})`).join(" · ")}`);
      console.log(`   body:     ${question.description.length} chars`);
      if (opts.post) {
        const token = (await loginWallet(BACKEND, MNEMONIC, Number(process.env.RT_AGENT_INDEX ?? 0))).bearer;
        const res = await fetch(`${BACKEND}/v1/questions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            title: question.title,
            description: question.description,
            successCriteria: question.successCriteria,
            initialBounty: process.env.RT_INITIAL_BOUNTY ?? "1000000",
          }),
        });
        const body = (await res.json()) as { id?: string };
        console.log(
          `   posted ${res.status}${body.id ? ` ${body.id} — now sponsor with fundingDeadline ≈ ${roundClose} so the round closes before the market` : ` ${JSON.stringify(body).slice(0, 120)}`}`,
        );
      } else {
        console.log(`   (dry-run — pass --post to create; then sponsor with fundingDeadline before ${roundClose})`);
      }
    }
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
  console.log(`Chain:   ${IS_MAINNET ? "Base mainnet (8453)" : "Base Sepolia (84532)"}`);
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
