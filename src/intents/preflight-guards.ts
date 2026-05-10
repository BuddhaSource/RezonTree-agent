// preflight-guards.ts — defensive runtime assertions for preflight
// fields consumed by the intent builders.
//
// The signed-intent builders parse fields out of the backend's
// preflight response with `BigInt(preflight.X)` or `hexToBytes(preflight.qid)`.
// When the backend ships a wire-shape change before the SDK is rebuilt,
// those calls explode deep inside the builder ("Cannot convert undefined
// to a BigInt", "hex.startsWith is not a function") and the agent has
// no actionable error.
//
// These guards run BEFORE the parses, fail fast, and tell the caller
// exactly which field went missing and why.

const DRIFT_HINT =
  "Backend version mismatch likely — rebuild and retry. " +
  "If persistent, see internal/lifecycle/wire_shape_test.go drift output for the canonical wire shape.";

/** Asserts a preflight field is a non-empty string. */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Preflight missing field '${name}' (expected non-empty string, got ${describe(value)}). ${DRIFT_HINT}`,
    );
  }
  return value;
}

/** Asserts a preflight field is a string that parses as a BigInt. */
export function requireBigIntStr(value: unknown, name: string): string {
  const s = requireString(value, name);
  try {
    BigInt(s);
  } catch {
    throw new Error(
      `Preflight field '${name}' is not a valid integer string (got ${JSON.stringify(s)}). ${DRIFT_HINT}`,
    );
  }
  return s;
}

/** Asserts a preflight field is a non-zero finite number. */
export function requireNonZeroNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) {
    throw new Error(
      `Preflight missing field '${name}' (expected non-zero number, got ${describe(value)}). ${DRIFT_HINT}`,
    );
  }
  return value;
}

/** Asserts a preflight field is a 0x-prefixed hex string. */
export function requireHexString(value: unknown, name: string): string {
  const s = requireString(value, name);
  if (!s.startsWith("0x")) {
    throw new Error(
      `Preflight field '${name}' is not 0x-prefixed hex (got ${JSON.stringify(s)}). ${DRIFT_HINT}`,
    );
  }
  return s;
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return `${typeof value} ${JSON.stringify(value)}`;
}
