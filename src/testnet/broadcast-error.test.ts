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
  it("detects native insufficient-funds (gas)", () => {
    expect(isInsufficientFunds(new Error("insufficient funds for gas * price + value"))).toBe(true);
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
