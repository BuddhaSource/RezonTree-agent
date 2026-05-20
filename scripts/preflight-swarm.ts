#!/usr/bin/env tsx
/**
 * preflight-swarm.ts — pick agents with sufficient USDC + ETH for a
 * planned swarm before launching it.
 *
 * Motivation (loop 0131 / mega25 retro): the May 17 25-question swarm
 * landed agents at the launchpad with 0.965 USDC — exactly 0.035 below
 * the 1 USDC stake floor. The agent's wallet check fired *after* boot,
 * burning ~30 turns and ~$0.60 of model time on retries that could
 * never succeed. The faucet top-up path silently failed (Circle returned
 * non-JSON 200), so the agent died without funds.
 *
 * Pre-flight catches this before launch: enumerate the named agents,
 * resolve each to its HD index via config/mcp-servers.yaml, compute
 * required USDC per role, check current balance, optionally redistribute
 * from the operator/treasury wallet (idx 0), and emit the list of names
 * to launch.
 *
 * Usage:
 *   tsx scripts/preflight-swarm.ts \
 *     --questioners "questioner-01,questioner-02" \
 *     --solvers "solver-02,solver-03,solver-04,solver-05,solver-06,solver-07,solver-08,solver-09" \
 *     --solutions-per-solver 5 \
 *     --questions-per-questioner 13 \
 *     [--stake-floor 1.0] [--sponsor-floor 1.5] [--headroom 0.5] \
 *     [--rebalance] [--treasury 0] [--json]
 *
 * Exit codes:
 *   0 — all requested agents viable (after any --rebalance)
 *   2 — at least one requested agent under-funded and no rebalance set,
 *       OR treasury too poor to cover the shortfall
 *   1 — config / runtime error
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  type Address,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const USDC = (process.env.RT_USDC_ADDRESS ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address;
const MN = process.env.RT_AGENT_MNEMONIC;

if (!MN) {
  console.error("RT_AGENT_MNEMONIC not set. Source .env first.");
  process.exit(1);
}

// Canonical name → HD-index map. Must match config/mcp-servers.yaml.
// Drift here means a topped-up name powers the wrong wallet.
const NAME_TO_IDX: Record<string, number> = {
  operator: 0,
  "questioner-01": 1,
  "questioner-02": 2,
  "solver-02": 3,
  "solver-03": 4,
  "solver-04": 5,
  "solver-05": 6,
  "solver-06": 7,
  "solver-07": 8,
  "solver-08": 9,
  "solver-09": 10,
};

const ERC20_BALANCE_OF = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const ERC20_TRANSFER = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

interface Args {
  questioners: string[];
  solvers: string[];
  solutionsPerSolver: number;
  questionsPerQuestioner: number;
  stakeFloor: number;
  sponsorFloor: number;
  headroom: number;
  rebalance: boolean;
  treasuryIdx: number;
  json: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const i = a.indexOf(flag);
    if (i < 0) {
      if (fallback === undefined) {
        console.error(`Missing required flag ${flag}`);
        process.exit(1);
      }
      return fallback;
    }
    return a[i + 1]!;
  };
  const splitList = (s: string) =>
    s.split(",").map((x) => x.trim()).filter(Boolean);
  return {
    questioners: splitList(get("--questioners", "questioner-01,questioner-02")),
    solvers: splitList(
      get(
        "--solvers",
        "solver-02,solver-03,solver-04,solver-05,solver-06,solver-07,solver-08,solver-09",
      ),
    ),
    solutionsPerSolver: Number(get("--solutions-per-solver", "5")),
    questionsPerQuestioner: Number(get("--questions-per-questioner", "13")),
    stakeFloor: Number(get("--stake-floor", "1.0")),
    sponsorFloor: Number(get("--sponsor-floor", "1.5")),
    headroom: Number(get("--headroom", "0.5")),
    rebalance: a.includes("--rebalance"),
    treasuryIdx: Number(get("--treasury", "0")),
    json: a.includes("--json"),
  };
}

interface AgentSnap {
  name: string;
  idx: number;
  role: "questioner" | "solver";
  address: Address;
  eth: bigint;
  usdc: bigint;
  needRaw: bigint;
}

function fmtUSDC(raw: bigint): string {
  return Number(formatUnits(raw, 6)).toFixed(3);
}
function fmtETH(raw: bigint): string {
  return Number(formatUnits(raw, 18)).toFixed(5);
}

async function readBalance(addr: Address) {
  const pc = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const [eth, usdc] = await Promise.all([
    pc.getBalance({ address: addr }),
    pc.readContract({
      address: USDC,
      abi: ERC20_BALANCE_OF,
      functionName: "balanceOf",
      args: [addr],
    }) as Promise<bigint>,
  ]);
  return { eth, usdc };
}

async function sendUSDC(
  fromIdx: number,
  toAddr: Address,
  amountRaw: bigint,
): Promise<string> {
  const pc = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const acct = mnemonicToAccount(MN!, { path: `m/44'/60'/0'/0/${fromIdx}` as const });
  const pk = `0x${Buffer.from(acct.getHdKey().privateKey!).toString("hex")}` as `0x${string}`;
  const fromAcct = privateKeyToAccount(pk);
  const wc = createWalletClient({ account: fromAcct, chain: baseSepolia, transport: http(RPC) });
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER,
    functionName: "transfer",
    args: [toAddr, amountRaw],
  });
  const hash = await wc.sendTransaction({ to: USDC, data });
  await pc.waitForTransactionReceipt({ hash });
  return hash;
}

async function main() {
  const args = parseArgs();

  // Per-role USDC requirement:
  //   solver:     K × stake_floor + headroom (per-action fee usually 0
  //               on testnet; headroom covers fee + rounding)
  //   questioner: K × sponsor_floor + headroom
  const solverNeed = parseUnits(
    String(args.solutionsPerSolver * args.stakeFloor + args.headroom),
    6,
  );
  const questionerNeed = parseUnits(
    String(args.questionsPerQuestioner * args.sponsorFloor + args.headroom),
    6,
  );

  // ETH gas floor — one signed-intent + permit + broadcast costs
  // ~0.0008 ETH on Base Sepolia. Multi-action agents need ~10x that.
  const ETH_FLOOR_WEI = parseUnits("0.005", 18);

  // Resolve each requested name to (idx, address), snapshot balance.
  const snap = async (
    name: string,
    role: "questioner" | "solver",
    need: bigint,
  ): Promise<AgentSnap> => {
    const idx = NAME_TO_IDX[name];
    if (idx === undefined) {
      console.error(`Unknown agent name: ${name} (not in NAME_TO_IDX)`);
      process.exit(1);
    }
    const acct = mnemonicToAccount(MN!, { path: `m/44'/60'/0'/0/${idx}` as const });
    const { eth, usdc } = await readBalance(acct.address as Address);
    return {
      name,
      idx,
      role,
      address: acct.address as Address,
      eth,
      usdc,
      needRaw: need,
    };
  };

  const agents: AgentSnap[] = [
    ...(await Promise.all(args.questioners.map((n) => snap(n, "questioner", questionerNeed)))),
    ...(await Promise.all(args.solvers.map((n) => snap(n, "solver", solverNeed)))),
  ];

  // Shortfall list = agents that don't meet their role's need.
  const shortfall = agents.filter((a) => a.usdc < a.needRaw);

  // Treasury snapshot (always needed for both reporting + rebalance).
  const treasuryAcct = mnemonicToAccount(MN!, { path: `m/44'/60'/0'/0/${args.treasuryIdx}` as const });
  const treasury = await readBalance(treasuryAcct.address as Address);

  // Rebalance phase — top up each shortfall agent to (needRaw).
  const topUps: { name: string; amount: bigint; tx: string }[] = [];
  if (args.rebalance && shortfall.length > 0) {
    const totalNeed = shortfall.reduce((s, a) => s + (a.needRaw - a.usdc), 0n);
    if (treasury.usdc < totalNeed) {
      const msg = `Treasury idx ${args.treasuryIdx} has ${fmtUSDC(treasury.usdc)} USDC; needs ${fmtUSDC(totalNeed)} to cover ${shortfall.length} agents.`;
      if (args.json) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              reason: "treasury_underfunded",
              treasury: { idx: args.treasuryIdx, usdc: fmtUSDC(treasury.usdc), need: fmtUSDC(totalNeed) },
              shortfall: shortfall.map((a) => ({ name: a.name, idx: a.idx, address: a.address, usdc: fmtUSDC(a.usdc), need: fmtUSDC(a.needRaw) })),
            },
            null,
            2,
          ),
        );
      } else {
        console.error(msg);
        console.error(`Fund the treasury or reduce swarm size. Manual faucet: https://faucet.circle.com`);
      }
      process.exit(2);
    }
    for (const a of shortfall) {
      const top = a.needRaw - a.usdc;
      const tx = await sendUSDC(args.treasuryIdx, a.address, top);
      topUps.push({ name: a.name, amount: top, tx });
      if (!args.json) {
        console.log(`  topped up ${a.name} (idx=${a.idx}) +${fmtUSDC(top)} USDC  tx=${tx.slice(0, 10)}…`);
      }
      // Refresh in-memory snapshot.
      a.usdc = a.needRaw;
    }
  }

  // Re-evaluate ETH + USDC after rebalance.
  const stillShort = agents.filter((a) => a.usdc < a.needRaw || a.eth < ETH_FLOOR_WEI);
  const ok = stillShort.length === 0;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          planned: {
            questioners: args.questioners.length,
            solvers: args.solvers.length,
            questionerUsdcNeed: fmtUSDC(questionerNeed),
            solverUsdcNeed: fmtUSDC(solverNeed),
            ethGasFloor: fmtETH(ETH_FLOOR_WEI),
          },
          treasury: {
            idx: args.treasuryIdx,
            address: treasuryAcct.address,
            usdc: fmtUSDC(treasury.usdc),
            eth: fmtETH(treasury.eth),
          },
          agents: agents.map((a) => ({
            name: a.name,
            idx: a.idx,
            role: a.role,
            address: a.address,
            usdc: fmtUSDC(a.usdc),
            eth: fmtETH(a.eth),
            need: fmtUSDC(a.needRaw),
            viable: a.usdc >= a.needRaw && a.eth >= ETH_FLOOR_WEI,
          })),
          topUps: topUps.map((t) => ({ name: t.name, amount: fmtUSDC(t.amount), tx: t.tx })),
          launchable: {
            questioners: agents.filter((a) => a.role === "questioner" && a.usdc >= a.needRaw && a.eth >= ETH_FLOOR_WEI).map((a) => a.name),
            solvers: agents.filter((a) => a.role === "solver" && a.usdc >= a.needRaw && a.eth >= ETH_FLOOR_WEI).map((a) => a.name),
          },
        },
        null,
        2,
      ),
    );
    process.exit(ok ? 0 : 2);
  }

  console.log("── pre-flight summary ──");
  console.log(`solver USDC need:       ${fmtUSDC(solverNeed)}  (${args.solutionsPerSolver}×${args.stakeFloor} + ${args.headroom} headroom)`);
  console.log(`questioner USDC need:   ${fmtUSDC(questionerNeed)}  (${args.questionsPerQuestioner}×${args.sponsorFloor} + ${args.headroom} headroom)`);
  console.log(`ETH gas floor:          ${fmtETH(ETH_FLOOR_WEI)}`);
  console.log(`treasury (idx ${args.treasuryIdx}):       ${fmtUSDC(treasury.usdc)} USDC, ${fmtETH(treasury.eth)} ETH`);
  console.log("");
  for (const a of agents) {
    const viable = a.usdc >= a.needRaw && a.eth >= ETH_FLOOR_WEI;
    const tag = viable ? "✓" : "✗";
    console.log(
      `  ${tag} ${a.name.padEnd(14)} idx=${String(a.idx).padStart(2)} ${a.address}  ${fmtUSDC(a.usdc).padStart(8)} / ${fmtUSDC(a.needRaw).padStart(7)} USDC  ${fmtETH(a.eth)} ETH  → ${a.role}`,
    );
  }
  console.log("");
  if (ok) {
    const qs = agents.filter((a) => a.role === "questioner").map((a) => a.name);
    const ss = agents.filter((a) => a.role === "solver").map((a) => a.name);
    console.log(`QUESTIONERS="${qs.join(" ")}"`);
    console.log(`SOLVERS="${ss.join(" ")}"`);
    console.log("");
    console.log("✓ all agents viable. Export the variables above and pass to the swarm launcher.");
  } else {
    console.log(`✗ ${stillShort.length} agent(s) NOT viable:`);
    for (const a of stillShort) {
      const reason: string[] = [];
      if (a.usdc < a.needRaw) reason.push(`USDC ${fmtUSDC(a.usdc)} < ${fmtUSDC(a.needRaw)}`);
      if (a.eth < ETH_FLOOR_WEI) reason.push(`ETH ${fmtETH(a.eth)} < ${fmtETH(ETH_FLOOR_WEI)}`);
      console.log(`    ${a.name}: ${reason.join(", ")}`);
    }
    console.log("");
    console.log("  Re-run with --rebalance to top up from the treasury.");
    console.log("  Or fund the treasury via Circle faucet, then retry.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
