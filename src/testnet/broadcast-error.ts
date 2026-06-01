// broadcast-error.ts — classify chain-broadcast errors for autonomous agents.
//
// viem's writeContract runs eth_estimateGas BEFORE sending; a tx that would
// revert throws pre-send with the real reason on a later line of the error.
// The generic e.message header ("The contract function X reverted with the
// following reason:") hides it — use shortMessage, which carries the actual
// revert string (e.g. "ERC20: transfer amount exceeds balance").
//
// An insufficient-funds / insufficient-allowance revert is a DETERMINISTIC
// precondition failure: it recurs identically until the wallet is funded. An
// autonomous agent must therefore STOP that wallet's funded (stake-pulling)
// actions rather than loop — exactly what a human/wallet does on "insufficient
// funds". This is the no-over-engineering fix: let the chain simulation be the
// gate (it already is) and just (1) surface the reason, (2) stop on it.

/** Best human-readable message: viem's shortMessage (carries the revert
 *  reason) when present, else the full message, else String(e). */
export function broadcastErrorMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { shortMessage?: unknown; message?: unknown };
    if (typeof anyE.shortMessage === "string" && anyE.shortMessage.length > 0) {
      return anyE.shortMessage;
    }
    if (typeof anyE.message === "string") return anyE.message;
  }
  return String(e);
}

/** True when the error is a deterministic insufficient-funds / insufficient-
 *  allowance precondition failure (the stake transferFrom can't be satisfied,
 *  or no native gas). NOT retryable — the agent should pause funded actions
 *  until the wallet is funded. Matches the OZ ERC-20 + EVM native phrasings. */
export function isInsufficientFunds(e: unknown): boolean {
  const m = broadcastErrorMessage(e).toLowerCase();
  return (
    m.includes("insufficient funds") || // native gas: "insufficient funds for gas * price + value"
    m.includes("insufficient balance") || // some tokens
    m.includes("insufficient allowance") || // OZ ERC20 (newer): "ERC20: insufficient allowance"
    m.includes("exceeds balance") || // OZ ERC20 (older): "transfer amount exceeds balance"
    m.includes("exceeds allowance") || // OZ ERC20 (older): "...exceeds allowance"
    m.includes("transfer amount exceeds") // OZ phrasing fragment
  );
}
