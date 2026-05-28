// faucet/circle.ts — Circle USDC testnet faucet integration.
//
// Circle migrated from a REST endpoint to a GraphQL API at
// https://faucet.circle.com/api/graphql. The mutation is:
//   requestToken(input: RequestTokenInput!): RequestTokenResponse
// where RequestTokenInput = { destinationAddress, blockchain, token }.
//
// ⚠ CAPTCHA NOTE: As of May 2026, Circle requires reCAPTCHA v3 on every
// faucet mutation. Calls without a valid captcha token return
// "ReCAPTCHA verification failed" — making fully automated dispenses
// impossible from a headless agent. This function still attempts the call
// (so it succeeds in any future window when CAPTCHA is lifted or bypassed),
// but degrades gracefully to a manual-fallback message when CAPTCHA fires.
//
// R-CLIENT-IS-TRUST-ORIGIN — caller passes the address explicitly;
// faucet doesn't verify ownership. Anyone can fund any address. Treat
// as a convenience, not an entitlement.
//
// Note: testnet only. Mainnet has no equivalent free faucet.

const CIRCLE_FAUCET_GRAPHQL = "https://faucet.circle.com/api/graphql";

// GraphQL mutation. The `blockchain` field value for Base Sepolia USDC is
// determined by Circle's internal enum (not "BASE_SEPOLIA" — that value
// doesn't exist in their Blockchain type as of May 2026). Use "BASE" which
// passes enum validation; Circle routes testnet USDC to the Base Sepolia
// contract when the destination address is on that chain.
const REQUEST_TOKEN_MUTATION = `
  mutation RequestToken($input: RequestTokenInput!) {
    requestToken(input: $input) {
      hash
    }
  }
`;

export interface FaucetResult {
  success: boolean;
  txHash?: string;
  message: string;
}

/**
 * Request testnet USDC from Circle's faucet for the given Base Sepolia
 * address. Returns success + tx hash when the faucet accepts; returns
 * { success:false, message } on rate-limit, CAPTCHA block, or upstream
 * error so callers can render a clear next-step instead of throwing.
 *
 * Faucet limits: ~10 USDC per request, rate-limited per IP and per
 * address. Repeated calls return a rate-limit error.
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
    resp = await fetch(CIRCLE_FAUCET_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: REQUEST_TOKEN_MUTATION,
        variables: {
          input: {
            destinationAddress: address,
            blockchain: "BASE",
            token: "USDC",
          },
        },
      }),
    });
  } catch (err) {
    return {
      success: false,
      message: `Faucet network error: ${err instanceof Error ? err.message : String(err)}. Visit https://faucet.circle.com manually.`,
    };
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return {
      success: false,
      message: `Faucet returned non-JSON response (status ${resp.status}). The API may have changed again. Manual fallback: https://faucet.circle.com`,
    };
  }

  // GraphQL always returns 200; errors are in the body.
  const gqlData = data as {
    data?: { requestToken?: { hash?: string } };
    errors?: Array<{ message?: string }>;
  };

  if (gqlData.errors && gqlData.errors.length > 0) {
    const msg = gqlData.errors[0]?.message ?? "unknown GraphQL error";

    // reCAPTCHA block — Circle requires browser-side token; headless agents can't satisfy it.
    if (msg.toLowerCase().includes("recaptcha")) {
      return {
        success: false,
        message: `Circle faucet requires reCAPTCHA verification — automated dispense is blocked. Visit https://faucet.circle.com and request USDC for ${address} manually.`,
      };
    }

    // Rate limit expressed as a GraphQL error (no HTTP 429 on GraphQL).
    if (msg.toLowerCase().includes("rate") || msg.toLowerCase().includes("limit")) {
      return {
        success: false,
        message: `Faucet rate-limited: ${msg}. Wait an hour or visit https://faucet.circle.com.`,
      };
    }

    return {
      success: false,
      message: `Faucet rejected: ${msg}. Manual fallback: https://faucet.circle.com`,
    };
  }

  const txHash = gqlData.data?.requestToken?.hash;
  return {
    success: true,
    txHash,
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
