import { describe, it, expect } from "vitest";
import { broadcastErrorMessage, isInsufficientFunds } from "./broadcast-error.js";

describe("broadcastErrorMessage", () => {
  it("prefers viem shortMessage over the generic reverted header", () => {
    const e = {
      shortMessage: "ERC20: transfer amount exceeds balance",
      message:
        'The contract function "sponsorSubmit" reverted with the following reason:\nERC20: transfer amount exceeds balance\n\nContract Call:\n  address: 0x...',
    };
    // The bug was logging e.message.split("\n")[0] = the header, hiding the reason.
    expect(broadcastErrorMessage(e)).toBe("ERC20: transfer amount exceeds balance");
  });
  it("falls back to message, then String", () => {
    expect(broadcastErrorMessage({ message: "boom" })).toBe("boom");
    expect(broadcastErrorMessage("plain string")).toBe("plain string");
    expect(broadcastErrorMessage(new Error("err obj"))).toBe("err obj");
  });
});

describe("isInsufficientFunds (deterministic, stop-don't-retry)", () => {
  it("detects the drained-stake ERC20 revert (the 54%-broadcast-failure cause)", () => {
    expect(isInsufficientFunds({ shortMessage: "ERC20: transfer amount exceeds balance" })).toBe(true);
  });
  it("detects native insufficient-funds (raw RPC message form)", () => {
    expect(isInsufficientFunds(new Error("insufficient funds for gas * price + value"))).toBe(true);
  });
  it("detects viem InsufficientFundsError by name (prose shortMessage that matches no token)", () => {
    // The real production shape: viem rewrites the RPC message, so shortMessage
    // is prose. Name-match catches it regardless.
    const viemErr = {
      name: "InsufficientFundsError",
      shortMessage:
        "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.",
    };
    expect(isInsufficientFunds(viemErr)).toBe(true);
    // ...and by prose substring even if the name were stripped.
    expect(isInsufficientFunds({ shortMessage: viemErr.shortMessage })).toBe(true);
  });
  it("detects InsufficientFundsError nested in the .cause chain", () => {
    const wrapped = {
      name: "EstimateGasExecutionError",
      shortMessage: "An unknown error occurred.",
      cause: { name: "InsufficientFundsError", shortMessage: "exceeds the balance of the account." },
    };
    expect(isInsufficientFunds(wrapped)).toBe(true);
  });
  it("detects allowance shortfall", () => {
    expect(isInsufficientFunds({ shortMessage: "ERC20: insufficient allowance" })).toBe(true);
  });
  it("does NOT flag retryable/unrelated errors", () => {
    expect(isInsufficientFunds({ shortMessage: "nonce too low" })).toBe(false);
    expect(isInsufficientFunds(new Error("network request failed"))).toBe(false);
    expect(isInsufficientFunds({ shortMessage: "QUESTION_NOT_OPEN" })).toBe(false);
    expect(isInsufficientFunds("")).toBe(false);
  });
});
