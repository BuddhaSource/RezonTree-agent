// Balance queries — cartridge loop 0062.
//
// Native ETH balance (for gas) + USDC balance (for L2
// participation) from the configured testnet RPC. Used by the
// bootstrap script (loop 65) to wait until the user funds each
// agent address before auto-registering.
//
// Read-only; no private keys, no transactions. Public client
// only.

import { type Address, createPublicClient, erc20Abi, http } from "viem";
import { baseSepolia } from "viem/chains";

import { loadTestnetConfig } from "../testnet/config.js";
import type { BalanceSnapshot, FundingThreshold } from "./types.js";

// Minimal shape of the balance-querying RPC client we need.
// Scoping down from `PublicClient` avoids viem's wide generic
// types on the singleton (which collide with the baseSepolia
// chain specialization). Anything returning these two methods
// can stand in as a test stub.
export interface BalanceClient {
  getBalance(args: { address: Address }): Promise<bigint>;
  readContract(args: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: "balanceOf";
    args: [Address];
  }): Promise<bigint>;
}

let _client: BalanceClient | null = null;

/** Lazy singleton — one public client per process. viem
 *  multiplexes RPC calls over a single connection, so repeated
 *  `balance.ts` usage shares the same transport. */
function getClient(): BalanceClient {
  if (_client) return _client;
  const cfg = loadTestnetConfig();
  _client = createPublicClient({
    chain: baseSepolia,
    transport: http(cfg.rpcUrl),
  }) as unknown as BalanceClient;
  return _client;
}

/** Overrideable for tests — inject a stub BalanceClient. Passing
 *  `null` resets to the lazy-default on next call. */
export function setBalanceClient(client: BalanceClient | null): void {
  _client = client;
}

/** Single-agent balance snapshot. */
export async function getAgentBalance(
  address: Address,
): Promise<BalanceSnapshot> {
  const cfg = loadTestnetConfig();
  const client = getClient();

  const [nativeWei, usdcMinor] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: cfg.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);

  return {
    address,
    chainId: cfg.chainId,
    nativeWei,
    usdcMinor,
    at: Math.floor(Date.now() / 1000),
  };
}

/** True iff the snapshot is at or above both the native + USDC
 *  thresholds. Used by bootstrap to decide "this agent is
 *  ready to sign in and auto-register." */
export function isFunded(
  snap: BalanceSnapshot,
  threshold: FundingThreshold,
): boolean {
  return (
    snap.nativeWei >= threshold.minNativeWei &&
    snap.usdcMinor >= threshold.minUsdcMinor
  );
}

/** Waits until the address meets the threshold OR the timeout
 *  expires. Polls every `pollMs`. Returns the final snapshot
 *  regardless of outcome; caller decides via `isFunded`. */
export async function waitForFunding(
  address: Address,
  threshold: FundingThreshold,
  opts: { timeoutMs: number; pollMs: number } = {
    timeoutMs: 600_000, // 10 min default
    pollMs: 10_000, // 10s default
  },
): Promise<BalanceSnapshot> {
  const deadline = Date.now() + opts.timeoutMs;
  let snap = await getAgentBalance(address);
  while (!isFunded(snap, threshold) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs));
    snap = await getAgentBalance(address);
  }
  return snap;
}
