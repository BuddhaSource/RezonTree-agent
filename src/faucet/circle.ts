// faucet/circle.ts — Circle USDC testnet faucet integration.
//
// Circle exposes a public faucet API for Base Sepolia USDC at
// https://faucet.circle.com. The web UI calls a JSON endpoint we can
// hit directly so agents can self-fund without a manual click-through.
//
// R-CLIENT-IS-TRUST-ORIGIN — caller passes the address explicitly;
// faucet doesn't verify ownership. Anyone can fund any address. Treat
// as a convenience, not an entitlement.
//
// Note: testnet only. Mainnet has no equivalent free faucet.

const CIRCLE_FAUCET_URL = "https://faucet.circle.com/api/faucet";
const BASE_SEPOLIA_CHAIN = "BASE_SEPOLIA";
const USDC_NATIVE = "USDC";

export interface FaucetResult {
  success: boolean;
  txHash?: string;
  message: string;
}

/**
 * Request testnet USDC from Circle's faucet for the given Base Sepolia
 * address. Returns success + tx hash when the faucet accepts; returns
 * { success:false, message } on rate-limit or upstream error so callers
 * can render a clear next-step instead of throwing.
 *
 * Faucet limits: ~10 USDC per request, rate-limited per IP and per
 * address. Repeated calls return 429.
 */
export async function requestUSDC(address: string): Promise<FaucetResult> {
  if (!address.startsWith("0x") || address.length !== 42) {
    return {
      success: false,
      message: `Invalid Base Sepolia address: ${address}. Expected 0x + 40 hex chars.`,
    };
  }

  let resp: Response;
  try {
    resp = await fetch(CIRCLE_FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: BASE_SEPOLIA_CHAIN,
        token: USDC_NATIVE,
        address,
      }),
    });
  } catch (err) {
    return {
      success: false,
      message: `Faucet network error: ${err instanceof Error ? err.message : String(err)}. Visit https://faucet.circle.com manually.`,
    };
  }

  if (resp.status === 429) {
    return {
      success: false,
      message: `Faucet rate-limited. Wait an hour or use a different IP. Manual fallback: https://faucet.circle.com`,
    };
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return {
      success: false,
      message: `Faucet returned non-JSON response (status ${resp.status}). Manual fallback: https://faucet.circle.com`,
    };
  }

  if (!resp.ok) {
    const err = data as { message?: string; error?: string };
    return {
      success: false,
      message: `Faucet rejected: ${err.message ?? err.error ?? "unknown"}. Manual fallback: https://faucet.circle.com`,
    };
  }

  const ok = data as { txHash?: string; transactionHash?: string };
  return {
    success: true,
    txHash: ok.txHash ?? ok.transactionHash,
    message: `USDC dispatched to ${address}. Confirmation usually within 1 minute.`,
  };
}

/**
 * Base Sepolia ETH faucet hint — Circle doesn't dispatch ETH. Agents
 * need ETH for gas (~0.001 ETH per tx) so we surface the canonical
 * options.
 */
export const ETH_FAUCETS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "Coinbase Base Sepolia", url: "https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet" },
  { name: "Alchemy", url: "https://www.alchemy.com/faucets/base-sepolia" },
  { name: "QuickNode", url: "https://faucet.quicknode.com/base/sepolia" },
];

export function ethFaucetMessage(address: string): string {
  return `Need testnet ETH for gas at ${address}. Pick one:\n${ETH_FAUCETS.map((f) => `  - ${f.name}: ${f.url}`).join("\n")}`;
}
