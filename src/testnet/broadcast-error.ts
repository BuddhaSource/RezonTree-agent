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
 *  until the wallet is funded. Matches the OZ ERC-20 + EVM native phrasings.
 *
 *  Native-gas shortfalls are special: viem rewrites the raw RPC message into
 *  an InsufficientFundsError whose shortMessage is prose ("The total cost ...
 *  exceeds the balance of the account."), so the raw "insufficient funds for
 *  gas" string never reaches shortMessage. We therefore also match viem's
 *  error NAME anywhere in the .cause chain — robust to the message rewrite. */
export function isInsufficientFunds(e: unknown): boolean {
  // viem InsufficientFundsError (native gas) — matched by name, not message,
  // because its shortMessage is prose that contains none of the tokens below.
  if (hasErrorName(e, "InsufficientFundsError")) return true;
  const m = broadcastErrorMessage(e).toLowerCase();
  return (
    m.includes("insufficient funds") || // raw RPC: "insufficient funds for gas * price + value"
    m.includes("insufficient balance") || // some tokens
    m.includes("insufficient allowance") || // OZ ERC20 (newer): "ERC20: insufficient allowance"
    m.includes("exceeds balance") || // OZ ERC20 (older): "transfer amount exceeds balance"
    m.includes("exceeds allowance") || // OZ ERC20 (older): "...exceeds allowance"
    m.includes("transfer amount exceeds") || // OZ phrasing fragment
    m.includes("total cost") || // viem InsufficientFundsError.shortMessage prose
    m.includes("exceeds the balance") // viem InsufficientFundsError.shortMessage prose
  );
}

/** Walk the viem/Error `.cause` chain looking for a given error `name`.
 *  Depth-bounded so a cyclic cause can't loop. */
function hasErrorName(e: unknown, name: string, depth = 0): boolean {
  if (depth > 5 || !e || typeof e !== "object") return false;
  const anyE = e as { name?: unknown; cause?: unknown };
  if (anyE.name === name) return true;
  return hasErrorName(anyE.cause, name, depth + 1);
}
