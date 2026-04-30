// format/token.ts — multi-currency display + parse helpers.
//
// Reads decimals from runtime token info (preflight or token
// registry). No hardcoded 10^6 anywhere. Built on viem's
// formatUnits / parseUnits so big-int math is borrowed, not
// reinvented; this file only adds symbol-aware display + a
// canonical TokenInfo shape the rest of the SDK threads through.

import { formatUnits, parseUnits } from "viem";

/** Canonical runtime token descriptor. Populated from a backend
 *  preflight response (`token` field) or a per-network registry. */
export interface TokenInfo {
  /** Optional protocol-side id (e.g. `"USDC"`); not used for math. */
  id?: string;
  /** ERC-20 contract address (lowercase 0x). */
  address: string;
  /** Display symbol (e.g. `"USDC"`, `"ETH"`). */
  symbol: string;
  /** Number of decimals — single source of truth for fmt/parse. */
  decimals: number;
  /** Optional EIP-155 chain id; useful for explorer links. */
  chain_id?: number;
}

export interface FmtTokenOptions {
  /** Max fractional digits to display. Defaults to
   *  min(token.decimals, 6). Trailing zeros are stripped. */
  precision?: number;
  /** Force or suppress the `$` USD prefix. Defaults to true when
   *  the symbol contains "USD" (case-insensitive). */
  usdPrefix?: boolean;
  /** Append the symbol after the number. Default true. */
  showSymbol?: boolean;
}

/**
 * Format raw token base units → display string with symbol.
 *
 * Examples (assuming USDC = 6 dp, ETH = 18 dp):
 *   fmtTokenAmount(100_000n, {symbol:"USDC", decimals:6})  → "$0.1 USDC"
 *   fmtTokenAmount(10n**17n,  {symbol:"ETH",  decimals:18}) → "0.1 ETH"
 *
 * Returns "—" when either input is undefined so callers can use
 * the helper unconditionally on optional fields.
 */
export function fmtTokenAmount(
  wei: bigint | string | undefined,
  token: Pick<TokenInfo, "decimals" | "symbol"> | undefined,
  opts?: FmtTokenOptions,
): string {
  if (wei === undefined || token === undefined) return "—";
  const n = typeof wei === "bigint" ? wei : BigInt(wei);
  const neg = n < 0n;
  const abs = neg ? -n : n;

  // viem.formatUnits handles arbitrary decimals via big-int math;
  // it returns a plain decimal string ("0.1", "1.234567"). We then
  // post-process precision + symbol locally.
  const raw = formatUnits(abs, token.decimals);

  const precision = opts?.precision ?? Math.min(token.decimals, 6);
  const trimmed = trimToPrecision(raw, precision);

  const usdPrefix =
    opts?.usdPrefix ?? token.symbol.toUpperCase().includes("USD");
  const showSymbol = opts?.showSymbol ?? true;
  const sign = neg ? "-" : "";
  const prefix = usdPrefix ? "$" : "";
  const suffix = showSymbol ? ` ${token.symbol}` : "";
  return `${sign}${prefix}${trimmed}${suffix}`;
}

/** Parse human display amount → token base units. Strips any
 *  symbol/$ prefix and tolerates inputs like "$1.50 USDC". */
export function parseTokenAmount(display: string, decimals: number): bigint {
  // Strip everything except digits, dot, and minus.
  const cleaned = display.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return 0n;
  // viem.parseUnits accepts the decimal string directly. We pre-
  // truncate the fractional part to `decimals` digits so callers
  // don't get an under-the-hood error for too-precise inputs.
  const [whole, frac = ""] = cleaned.split(".");
  const truncated = frac.slice(0, decimals);
  const normalized = truncated === "" ? whole : `${whole}.${truncated}`;
  return parseUnits(normalized as `${number}`, decimals);
}

/** Strip trailing zeros from a decimal string and clamp to at
 *  most `precision` fractional digits. Pure string surgery; no
 *  rounding (we floor — display is never overstated). */
function trimToPrecision(raw: string, precision: number): string {
  const dot = raw.indexOf(".");
  if (dot === -1) return raw;
  const whole = raw.slice(0, dot);
  let frac = raw.slice(dot + 1, dot + 1 + precision);
  frac = frac.replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}
