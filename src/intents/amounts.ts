// amounts.ts — token amount encoding.
//
// parseAmountToWei converts a human-decimal amount string (e.g. "1.5")
// into the token's base-unit bigint given its decimals (USDC = 6). It
// is the shared amount encoder every signed-flow caller uses before
// building an Envelope's funds (poolIn / stakeAmount / poolOut).
//
// Relocated from the deleted v1 sponsor-intent.ts (#595/#393): that file
// held the flat-struct SponsorIntent builders that the unified-envelope
// cutover replaced (the live path is sponsor-witness.ts + quadphase-
// flow.ts), but parseAmountToWei is action-agnostic and stayed live, so
// it moved here rather than dying with the dead builders.

export function parseAmountToWei(
  humanAmount: string,
  decimals: number,
): bigint {
  const trimmed = humanAmount.trim();
  if (!trimmed) {
    throw new Error("Amount is empty.");
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Amount "${humanAmount}" is not a non-negative decimal.`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount has ${frac.length} decimal places but token supports only ${decimals}.`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole + padded);
}
