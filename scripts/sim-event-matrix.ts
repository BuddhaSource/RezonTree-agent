#!/usr/bin/env tsx
// scripts/sim-event-matrix.ts — Quadphase v2 oracle event-matrix
// simulator (task #529).
//
// PURPOSE
// -------
// Walks the closed set of chain-bound action types and drives one
// through-the-stack flow per action against a local anvil + ponder +
// backend stack. Every submitted intent_hash is recorded so the
// companion assert-event-matrix.ts can verify all 4 layers
// (chain → ponder_indexer → public.* → /v1/* API) end-to-end.
//
// SCOPE
// -----
// Currently implemented:
//
//   ✅ Skeleton — argument parsing, env loading, wallet derivation,
//      and the action-order plan are wired.
//   ✅ Token mint — uses anvil's eth_sendTransaction to mint mUSDC
//      to the three test wallets via the ERC20Mock.mint(...) call.
//
// Deferred (see MEMORY.md → project_oracle_event_matrix.md):
//
//   ⚠ Action submission — the per-action submit calls require:
//     (a) Backend reconfigured with ORACLE_CHAIN_ID=31337, the new
//         RezonForge address, and the mUSDC token registered in the
//         tokens registry.
//     (b) Backend agent registration via /auth/token client_credentials
//         flow with `tok_` secrets bound to each anvil wallet, OR a
//         wallet-only auth path that mints a JWT from a wallet sig.
//     (c) Per-action preflight wiring (sponsor → cosponsor → commit →
//         vote → settle → claim → refund + abandon) using the existing
//         buildXWitness + submitQuadphase helpers from
//         src/intents/.
//     (d) Time advance via anvil_setNextBlockTimestamp /
//         evm_increaseTime for Refund + Abandon.
//
//   These pieces are independent and can land incrementally — see
//   the runbook in MEMORY.md for the order.
//
// USAGE
// -----
//   # 1. Bring up the local stack:
//   #    bash RezonTree/scripts/deploy-anvil.sh
//   #    PONDER_CHAIN_ID=31337 PONDER_RPC_URL=http://localhost:8545 \
//   #      PONDER_FORGE_ADDRESS=<from .env.local-anvil> \
//   #      docker compose -f RezonTree/docker-compose.ponder.yml up -d
//   #    cd RezonTree && ORACLE_CHAIN_ID=31337 FORGE_ADDRESS=<...> make run
//   #
//   # 2. Run the simulator:
//   npx tsx scripts/sim-event-matrix.ts \
//     --chain-id 31337 \
//     --rpc-url http://127.0.0.1:8545 \
//     --backend-url http://localhost:8080 \
//     --anvil-mnemonic "test test test test test test test test test test test junk"
//
//   # 3. Verify across all 4 layers:
//   npx tsx scripts/assert-event-matrix.ts --run-dir .matrix-run/<id>

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

interface Args {
  chainId: number;
  rpcUrl: string;
  backendUrl: string;
  mnemonic: string;
  usdcAddress: Address;
  forgeAddress: Address;
  runId: string;
}

function parseArgs(): Args {
  const out: Partial<Args> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    switch (k) {
      case "--chain-id": out.chainId = Number(v); i++; break;
      case "--rpc-url": out.rpcUrl = v; i++; break;
      case "--backend-url": out.backendUrl = v; i++; break;
      case "--anvil-mnemonic": out.mnemonic = v; i++; break;
      case "--usdc-address": out.usdcAddress = v as Address; i++; break;
      case "--forge-address": out.forgeAddress = v as Address; i++; break;
      case "--run-id": out.runId = v; i++; break;
    }
  }
  return {
    chainId: out.chainId ?? Number(process.env.RT_LOCAL_CHAIN_ID ?? "31337"),
    rpcUrl: out.rpcUrl ?? process.env.RT_LOCAL_RPC_URL ?? "http://127.0.0.1:8545",
    backendUrl: out.backendUrl ?? process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080",
    mnemonic: out.mnemonic ?? process.env.RT_ANVIL_MNEMONIC ?? "test test test test test test test test test test test junk",
    usdcAddress: (out.usdcAddress ?? process.env.RT_LOCAL_USDC_ADDRESS) as Address,
    forgeAddress: (out.forgeAddress ?? process.env.RT_LOCAL_FORGE_ADDRESS) as Address,
    runId: out.runId ?? new Date().toISOString().replace(/[:.]/g, "-"),
  };
}

const ACTION_ORDER = [
  "Sponsor",
  "Cosponsor",
  "Commit",
  "Vote",
  "Settle",
  "Claim",
  "Refund",
  "Abandon",
] as const;

type Action = (typeof ACTION_ORDER)[number];

interface SubmittedIntent {
  action: Action;
  intentHash?: Hex;
  txHash?: Hex;
  qid?: Hex;
  signer: Address;
  status: "ok" | "skipped" | "error";
  reason?: string;
}

async function mintMUSDC(
  walletClient: WalletClient,
  usdc: Address,
  recipient: Address,
  amount: bigint,
): Promise<Hex> {
  const erc20MockAbi = parseAbi([
    "function mint(address account, uint256 amount) external",
  ]);
  const hash = await walletClient.writeContract({
    address: usdc,
    abi: erc20MockAbi,
    functionName: "mint",
    args: [recipient, amount],
    chain: null,
    account: walletClient.account!,
  });
  return hash;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.usdcAddress || !args.forgeAddress) {
    console.error(
      "error: --usdc-address and --forge-address required (or source .env.local-anvil first).",
    );
    process.exit(2);
  }

  console.log(`sim-event-matrix  run_id=${args.runId}`);
  console.log(`  chain_id    : ${args.chainId}`);
  console.log(`  rpc         : ${args.rpcUrl}`);
  console.log(`  backend     : ${args.backendUrl}`);
  console.log(`  forge       : ${args.forgeAddress}`);
  console.log(`  mUSDC       : ${args.usdcAddress}`);

  // Derive three test wallets from the deterministic mnemonic. We
  // use indices 1/2/3 (NOT 0, which is the deployer in
  // deploy-anvil.sh and is reserved for chain-admin / minting work).
  const sponsor = mnemonicToAccount(args.mnemonic, { addressIndex: 1 });
  const solver = mnemonicToAccount(args.mnemonic, { addressIndex: 2 });
  const voter = mnemonicToAccount(args.mnemonic, { addressIndex: 3 });

  console.log(`  sponsor     : ${sponsor.address}`);
  console.log(`  solver      : ${solver.address}`);
  console.log(`  voter       : ${voter.address}`);

  const pub = createPublicClient({ transport: http(args.rpcUrl) });

  // Deployer wallet (key #0) is the only one allowed to mint via
  // anvil cheatcodes; ERC20Mock.mint is permissionless so any wallet
  // works, but we centralize through key #0 anyway for parity with
  // how a real airdrop would flow.
  const deployer = mnemonicToAccount(args.mnemonic, { addressIndex: 0 });
  const minter: WalletClient = createWalletClient({
    account: deployer,
    transport: http(args.rpcUrl),
  });

  // Each wallet gets 10,000 mUSDC (6 decimals → 10_000 * 1e6).
  const mintAmount = parseUnits("10000", 6);
  console.log("\n>> minting mUSDC to test wallets");
  for (const w of [sponsor, solver, voter]) {
    const tx = await mintMUSDC(minter, args.usdcAddress, w.address, mintAmount);
    console.log(`   ${w.address}  tx=${tx}`);
  }

  // -----------------------------------------------------------------
  // Per-action submission. Each block is currently a placeholder
  // that records "skipped — wiring deferred" so the assert harness
  // and downstream tooling have a consistent output shape from day
  // one. As each action's wiring lands, replace the placeholder with
  // a real preflight + buildXWitness + submitQuadphase flow.
  // -----------------------------------------------------------------
  const submitted: SubmittedIntent[] = [];
  for (const action of ACTION_ORDER) {
    submitted.push({
      action,
      signer:
        action === "Vote" ? voter.address :
        action === "Commit" || action === "Claim" || action === "Refund" ? solver.address :
        sponsor.address,
      status: "skipped",
      reason: "action wiring deferred — see MEMORY.md::project_oracle_event_matrix.md",
    });
    console.log(`   [${action.padEnd(9)}]  skipped (wiring deferred)`);
  }

  // -----------------------------------------------------------------
  // Persist the run manifest so assert-event-matrix.ts can read it.
  // -----------------------------------------------------------------
  const runDir = join(process.cwd(), ".matrix-run", args.runId);
  mkdirSync(runDir, { recursive: true });
  const manifest = {
    runId: args.runId,
    chainId: args.chainId,
    rpcUrl: args.rpcUrl,
    backendUrl: args.backendUrl,
    forgeAddress: args.forgeAddress,
    usdcAddress: args.usdcAddress,
    wallets: {
      sponsor: sponsor.address,
      solver: solver.address,
      voter: voter.address,
    },
    submitted,
  };
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\n>> wrote ${join(runDir, "manifest.json")}`);
  console.log(
    `>> next: npx tsx scripts/assert-event-matrix.ts --run-dir ${runDir}`,
  );

  // Confirm pub client works so we know the RPC end is alive even
  // before per-action wiring lands. (Useful smoke-test for CI.)
  const blockNumber = await pub.getBlockNumber();
  console.log(`>> RPC alive: head block = ${blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
