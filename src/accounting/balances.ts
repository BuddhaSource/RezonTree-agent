// accounting/balances.ts — fund-conservation audit.
//
// Every protocol action moves the question's settlement token
// between known actors: agent wallets and the Router contract.
// Total token supply across all actors is invariant over any action
// (gas is paid in native ETH, not the settlement token).
//
// The token isn't always USDC — RezonForge supports any ERC-20 the
// sponsor binds at sponsor() time. The TokenInfo passed to snapshot()
// + the print* helpers carries decimals + symbol so display works
// for 6-dp USDC, 18-dp WETH, or anything else.
//
// Snapshots capture balances and per-qid Router state; verifyDelta
// compares two snapshots against an ExpectedDelta and reports any
// drift as an accounting bug.

import type { Address, Hex, PublicClient } from "viem";
import { erc20Abi } from "viem";

import { fmtTokenAmount, type TokenInfo } from "../format/token.js";

/** One token-balance snapshot for a named actor. */
export interface ActorBalance {
  name: string;
  address: Address;
  /** Settlement-token balance in base units. */
  tokenAmount: bigint;
}

/** Full balance snapshot across the system. */
export interface BalanceSnapshot {
  takenAtMs: number;
  wallets: ActorBalance[];
  router: {
    address: Address;
    /** Router's total holdings of the settlement token. */
    totalToken: bigint;
    /** Per-qid pool amounts (known qids only — we track them as
     *  agents create them). Sum ≤ totalToken; residual = totalToken
     *  − sum(pools) − sum(stakes). */
    pools: Record<Hex, bigint>;
    /** Known solution-stake amounts keyed by intent_hash. */
    solutionStakes: Record<Hex, bigint>;
    /** Known vote-stake amounts keyed by intent_hash. */
    voteStakes: Record<Hex, bigint>;
  };
  /** Sum across wallets + router. Invariant over any action. */
  totalToken: bigint;
}

/** Inputs to take a snapshot. */
export interface SnapshotInput {
  publicClient: PublicClient;
  /** ERC-20 contract address whose balance we're tracking. */
  token: Address;
  router: Address;
  wallets: { name: string; address: Address }[];
  /** Known qids to query pool amounts for. */
  qids: Hex[];
  /** Known intent hashes to query stakes for. */
  solutionIntentHashes: Hex[];
  voteIntentHashes: Hex[];
}

// `questions(bytes32)` getter returns the full QuestionState tuple.
// Field order MUST match RezonForge.QuestionState declaration
// byte-for-byte; truncating mis-aligns viem's tuple decoder and
// silently corrupts every downstream read (`q[3]` would no longer
// be poolAmount).
const routerReadAbi = [
  {
    type: "function",
    name: "questions",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "token", type: "address" },
      { name: "oracle", type: "address" },
      { name: "sponsor", type: "address" },
      { name: "stakeFloor", type: "uint256" },
      { name: "stakeBasisPoints", type: "uint256" },
      { name: "sponsorshipFloor", type: "uint256" },
      { name: "voteFee", type: "uint256" },
      { name: "commitFee", type: "uint256" },
      { name: "noSolutionGracePeriod", type: "uint256" },
      { name: "feeShareBps", type: "uint256" },
      { name: "platformFeeRecipient", type: "address" },
      { name: "abandonmentGracePeriod", type: "uint256" },
      { name: "solutionCount", type: "uint32" },
      { name: "totalSponsorship", type: "uint256" },
      { name: "poolAmount", type: "uint256" },
      { name: "fundingDeadline", type: "uint256" },
      { name: "totalClaimable", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "solutionStake",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "voteStake",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function snapshot(input: SnapshotInput): Promise<BalanceSnapshot> {
  const walletBalances = await Promise.all(
    input.wallets.map(async (w): Promise<ActorBalance> => ({
      name: w.name,
      address: w.address,
      tokenAmount: (await input.publicClient.readContract({
        address: input.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [w.address],
      })) as bigint,
    })),
  );

  const routerTotal = (await input.publicClient.readContract({
    address: input.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [input.router],
  })) as bigint;

  const pools: Record<Hex, bigint> = {};
  for (const qid of input.qids) {
    // QuestionState tuple layout — see routerReadAbi above. Fields 0..17;
    // poolAmount sits at index 15 (after solutionCount + totalSponsorship).
    const q = (await input.publicClient.readContract({
      address: input.router,
      abi: routerReadAbi,
      functionName: "questions",
      args: [qid],
    })) as readonly [
      number,    // 0  status
      Address,   // 1  token
      Address,   // 2  oracle
      Address,   // 3  sponsor
      bigint,    // 4  stakeFloor
      bigint,    // 5  stakeBasisPoints
      bigint,    // 6  sponsorshipFloor
      bigint,    // 7  voteFee
      bigint,    // 8  commitFee
      bigint,    // 9  noSolutionGracePeriod
      bigint,    // 10 feeShareBps
      Address,   // 11 platformFeeRecipient
      bigint,    // 12 abandonmentGracePeriod
      number,    // 13 solutionCount
      bigint,    // 14 totalSponsorship
      bigint,    // 15 poolAmount
      bigint,    // 16 fundingDeadline
      bigint,    // 17 totalClaimable
    ];
    pools[qid] = q[15];
  }

  const solutionStakes: Record<Hex, bigint> = {};
  for (const h of input.solutionIntentHashes) {
    solutionStakes[h] = (await input.publicClient.readContract({
      address: input.router,
      abi: routerReadAbi,
      functionName: "solutionStake",
      args: [h],
    })) as bigint;
  }

  const voteStakes: Record<Hex, bigint> = {};
  for (const h of input.voteIntentHashes) {
    voteStakes[h] = (await input.publicClient.readContract({
      address: input.router,
      abi: routerReadAbi,
      functionName: "voteStake",
      args: [h],
    })) as bigint;
  }

  const totalToken =
    walletBalances.reduce((acc, w) => acc + w.tokenAmount, 0n) + routerTotal;

  return {
    takenAtMs: Date.now(),
    wallets: walletBalances,
    router: {
      address: input.router,
      totalToken: routerTotal,
      pools,
      solutionStakes,
      voteStakes,
    },
    totalToken,
  };
}

// ─── Expected-delta spec ───────────────────────────────────────

export type ActionName =
  | "fund"
  | "commit"
  | "vote"
  | "settle" // no token movement
  | "claim"
  | "claim_solution_stake"
  | "claim_vote_stake"
  | "sweep_residuals";

/** Per-action expected delta. Positive = inflow, negative = outflow.
 *  Units: settlement-token base units (decimals come from TokenInfo
 *  passed to print* helpers). Unspecified wallets default to 0
 *  delta. */
export interface ExpectedDelta {
  action: ActionName;
  byAddress: Partial<Record<Address, bigint>>;
  routerTotal: bigint;
  qid?: Hex;
  poolDelta?: bigint;
  intentHash?: Hex;
  solutionStakeDelta?: bigint;
  voteStakeDelta?: bigint;
  /** Overall chain total should be unchanged (no token leaves). */
  chainTotal: bigint; // always 0n
}

/** Compare two snapshots and a declared expected delta. */
export function verifyDelta(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  expected: ExpectedDelta,
): {
  ok: boolean;
  mismatches: string[];
  actualByAddress: Record<Address, bigint>;
  actualRouterTotal: bigint;
  actualChainTotal: bigint;
} {
  const mismatches: string[] = [];

  // Per-wallet actual delta.
  const actualByAddress: Record<Address, bigint> = {};
  for (const w of after.wallets) {
    const b = before.wallets.find((x) => x.address === w.address);
    if (!b) continue;
    actualByAddress[w.address] = w.tokenAmount - b.tokenAmount;
  }
  for (const addr of Object.keys(expected.byAddress) as Address[]) {
    const exp = expected.byAddress[addr] ?? 0n;
    const act = actualByAddress[addr] ?? 0n;
    if (exp !== act) {
      mismatches.push(
        `wallet ${addr}: expected ${exp}, actual ${act} (diff ${act - exp})`,
      );
    }
  }

  // Wallets NOT in expected should have delta 0.
  for (const [addr, act] of Object.entries(actualByAddress)) {
    if (!(addr in expected.byAddress) && act !== 0n) {
      mismatches.push(
        `wallet ${addr}: expected 0 (not in spec), actual ${act}`,
      );
    }
  }

  // Router total.
  const actualRouterTotal = after.router.totalToken - before.router.totalToken;
  if (actualRouterTotal !== expected.routerTotal) {
    mismatches.push(
      `router total: expected ${expected.routerTotal}, actual ${actualRouterTotal}`,
    );
  }

  // Pool delta for specific qid.
  if (expected.qid !== undefined) {
    const poolBefore = before.router.pools[expected.qid] ?? 0n;
    const poolAfter = after.router.pools[expected.qid] ?? 0n;
    const actualPool = poolAfter - poolBefore;
    const expectedPool = expected.poolDelta ?? 0n;
    if (actualPool !== expectedPool) {
      mismatches.push(
        `pool[${expected.qid}]: expected ${expectedPool}, actual ${actualPool}`,
      );
    }
  }

  // Stake deltas.
  if (expected.intentHash !== undefined) {
    if (expected.solutionStakeDelta !== undefined) {
      const b = before.router.solutionStakes[expected.intentHash] ?? 0n;
      const a = after.router.solutionStakes[expected.intentHash] ?? 0n;
      const actual = a - b;
      if (actual !== expected.solutionStakeDelta) {
        mismatches.push(
          `solutionStake[${expected.intentHash}]: expected ${expected.solutionStakeDelta}, actual ${actual}`,
        );
      }
    }
    if (expected.voteStakeDelta !== undefined) {
      const b = before.router.voteStakes[expected.intentHash] ?? 0n;
      const a = after.router.voteStakes[expected.intentHash] ?? 0n;
      const actual = a - b;
      if (actual !== expected.voteStakeDelta) {
        mismatches.push(
          `voteStake[${expected.intentHash}]: expected ${expected.voteStakeDelta}, actual ${actual}`,
        );
      }
    }
  }

  // Chain total must be conserved (no settlement token leaves).
  const actualChainTotal = after.totalToken - before.totalToken;
  if (actualChainTotal !== expected.chainTotal) {
    mismatches.push(
      `CHAIN TOTAL DRIFTED: expected ${expected.chainTotal}, actual ${actualChainTotal} — settlement token leaked out of or into the system`,
    );
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    actualByAddress,
    actualRouterTotal,
    actualChainTotal,
  };
}

// ─── Pretty printing ───────────────────────────────────────────
//
// All print* helpers take a TokenInfo so display matches whatever
// settlement token the question is denominated in (USDC, WETH,
// any ERC-20). Decimals + symbol come from preflight or a per-
// network registry — never hardcoded.

/** Re-export so accounting callers can import in one place. */
export { fmtTokenAmount } from "../format/token.js";
export type { TokenInfo } from "../format/token.js";

const PAD = 16;

export function printSnapshot(
  snap: BalanceSnapshot,
  token: TokenInfo,
  title = "Balance sheet",
): void {
  const fmt = (v: bigint): string => fmtTokenAmount(v, token).padStart(PAD);
  console.log("");
  console.log(`── ${title} @ ${new Date(snap.takenAtMs).toISOString()} ──`);
  for (const w of snap.wallets) {
    console.log(`  ${w.name.padEnd(14)} ${w.address}  ${fmt(w.tokenAmount)}`);
  }
  console.log(
    `  ${"router".padEnd(14)} ${snap.router.address}  ${fmt(snap.router.totalToken)}`,
  );
  const poolsSum = Object.values(snap.router.pools).reduce((a, b) => a + b, 0n);
  const solStakesSum = Object.values(snap.router.solutionStakes).reduce(
    (a, b) => a + b,
    0n,
  );
  const voteStakesSum = Object.values(snap.router.voteStakes).reduce(
    (a, b) => a + b,
    0n,
  );
  const residuals =
    snap.router.totalToken - poolsSum - solStakesSum - voteStakesSum;
  console.log(
    `    ├─ pools       ${fmt(poolsSum)}  (${Object.keys(snap.router.pools).length} qid${Object.keys(snap.router.pools).length === 1 ? "" : "s"})`,
  );
  console.log(
    `    ├─ sol stakes   ${fmt(solStakesSum)}  (${Object.keys(snap.router.solutionStakes).length} intent${Object.keys(snap.router.solutionStakes).length === 1 ? "" : "s"})`,
  );
  console.log(
    `    ├─ vote stakes  ${fmt(voteStakesSum)}  (${Object.keys(snap.router.voteStakes).length} intent${Object.keys(snap.router.voteStakes).length === 1 ? "" : "s"})`,
  );
  console.log(`    └─ residuals   ${fmt(residuals)}`);
  console.log(`  ${"─".repeat(58)}`);
  console.log(
    `  ${"chain total".padEnd(14)} ${" ".repeat(42)} ${fmt(snap.totalToken)}`,
  );
}

export function printDelta(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  token: TokenInfo,
  label: string,
): void {
  console.log("");
  console.log(`── Δ ${label} ──`);
  for (const w of after.wallets) {
    const b = before.wallets.find((x) => x.address === w.address);
    if (!b) continue;
    const d = w.tokenAmount - b.tokenAmount;
    if (d !== 0n) {
      const sign = d > 0n ? "+" : "";
      console.log(`  ${w.name.padEnd(14)} ${sign}${fmtTokenAmount(d, token)}`);
    }
  }
  const routerDelta = after.router.totalToken - before.router.totalToken;
  if (routerDelta !== 0n) {
    const sign = routerDelta > 0n ? "+" : "";
    console.log(
      `  ${"router".padEnd(14)} ${sign}${fmtTokenAmount(routerDelta, token)}`,
    );
  }
  const chainDelta = after.totalToken - before.totalToken;
  console.log(
    `  ${"chain total".padEnd(14)} ${
      chainDelta === 0n
        ? "≡ (conserved)"
        : `DRIFT ${fmtTokenAmount(chainDelta, token)}`
    }`,
  );
}
