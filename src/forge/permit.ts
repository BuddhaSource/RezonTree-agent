// permit.ts — EIP-2612 USDC permit signer.
//
// RezonForge's fund/commitSolution/castVote entries pull USDC from
// the caller's wallet via permit — a gasless authorization that
// avoids the approve+transferFrom dance. The permit is a SEPARATE
// signature from the VoteIntent/CommitIntent/FundIntent — Router
// accepts both.
//
// Permit typehash:
//   Permit(address owner,address spender,uint256 value,
//          uint256 nonce,uint256 deadline)
//
// Domain for USDC follows the standard EIP-2612 + ERC-20-Permit
// shape: keccak of name/version/chainId/verifyingContract. USDC
// on Base Sepolia exposes `name()`, `version()`, `DOMAIN_SEPARATOR()`,
// and `nonces(owner)` as public reads; we use those to build the
// typed data.
//
// R-CHAIN-VERIFIES-INTENT (analogous): the USDC contract
// recomputes keccak(permit) and recovers the owner on-chain. Any
// drift here rejects with ECDSA: invalid signature.

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  parseAbi,
} from "viem";

/** USDC ERC20-Permit reads used to construct the permit typed data. */
const USDC_PERMIT_READS_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
]);

export interface PermitSig {
  v: number;
  r: Hex;
  s: Hex;
  /** Returned so the caller can bind it into the Router intent's
   *  expiresAt or otherwise track how long the authorization is
   *  valid. Unix seconds. */
  deadline: bigint;
}

export interface SignUSDCPermitParams {
  /** The USDC token contract address. */
  usdc: Address;
  /** Router address — the "spender" authorized to pull tokens. */
  spender: Address;
  /** Amount in USDC wei (6-decimal). */
  value: bigint;
  /** Unix seconds. Keep short (e.g. now + 10min) — matches intent TTL. */
  deadline: bigint;
}

/**
 * Signs an EIP-2612 permit authorizing the Router to pull `value`
 * USDC from the caller's wallet by `deadline`. Reads live
 * DOMAIN + nonce from chain so the signature matches exactly what
 * USDC's on-chain permit expects.
 *
 * `publicClient` must be dialled against the SAME chain the
 * wallet + USDC + Router share — mismatched chains produce valid
 * signatures for the wrong chain, which USDC's domain separator
 * rejects.
 */
export async function signUSDCPermit(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: SignUSDCPermitParams,
): Promise<PermitSig> {
  const owner = wallet.account?.address;
  if (!owner) {
    throw new Error("WalletClient has no account — cannot sign permit.");
  }

  // USDC's DOMAIN_SEPARATOR derives from these four fields. We
  // read name + version from chain (rather than hardcoding
  // "USD Coin" / "2") so a future USDC redeploy with different
  // metadata doesn't silently break signing.
  const [name, version, nonce] = await Promise.all([
    publicClient.readContract({
      address: params.usdc,
      abi: USDC_PERMIT_READS_ABI,
      functionName: "name",
    }),
    publicClient.readContract({
      address: params.usdc,
      abi: USDC_PERMIT_READS_ABI,
      functionName: "version",
    }),
    publicClient.readContract({
      address: params.usdc,
      abi: USDC_PERMIT_READS_ABI,
      functionName: "nonces",
      args: [owner],
    }),
  ]);

  const chainId = wallet.chain?.id;
  if (chainId === undefined) {
    throw new Error("WalletClient has no chain configured — cannot sign permit.");
  }

  // EIP-2612 canonical permit types. Field order is fixed by the
  // standard; reorder and USDC's on-chain recover fails.
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  } as const;

  // wallet.account narrowed at the guard on line 76 — the !owner check
  // above already returned, so wallet.account is non-null here. TS
  // can't narrow `wallet.account` from a check on `wallet.account?.address`
  // alone, so we re-assert.
  const account = wallet.account!;
  const signature = await wallet.signTypedData({
    account,
    domain: {
      name,
      version,
      chainId,
      verifyingContract: params.usdc,
    },
    types,
    primaryType: "Permit",
    message: {
      owner,
      spender: params.spender,
      value: params.value,
      nonce,
      deadline: params.deadline,
    },
  });

  // Split the 65-byte (0x + 130 hex) signature into V/R/S. USDC's
  // permit accepts these as three separate args, not a combined
  // blob.
  if (!signature.startsWith("0x") || signature.length !== 132) {
    throw new Error(
      `Unexpected signature length from signTypedData: ${signature.length}`,
    );
  }
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  return { v, r, s, deadline: params.deadline };
}
