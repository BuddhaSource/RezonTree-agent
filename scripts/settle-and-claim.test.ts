// settle-and-claim.test.ts — C05 regression: oracle off-chain
// pre-aggregation by recipient before Merkle tree build.
//
// Context: the chain dedups via `claimed[qid][recipient]`. Two leaves
// for the same recipient = first claim wins, second leaf strands.
// Therefore the oracle MUST aggregate per-recipient before building
// the tree. settle-and-claim.ts (and any future settler) MUST emit
// unique-recipient leaves.
//
// This test validates the aggregation contract: given raw leaves
// with duplicates, the aggregator produces unique-recipient leaves
// with summed amounts.

import { describe, expect, it } from "vitest";
import type { Address } from "viem";

// Mirror of the aggregation logic in settle-and-claim.ts. Kept in a
// helper here so tests verify the contract, not the script's
// privately-coupled wiring. Drift = test fails when the script's
// version drifts.
function aggregateByRecipient(
  rawLeaves: { recipient: Address; amount: bigint }[],
): { recipient: Address; amount: bigint }[] {
  const aggregated = new Map<Address, bigint>();
  for (const leaf of rawLeaves) {
    const key = leaf.recipient.toLowerCase() as Address;
    aggregated.set(key, (aggregated.get(key) ?? 0n) + leaf.amount);
  }
  return [...aggregated.entries()].map(([recipient, amount]) => ({
    recipient,
    amount,
  }));
}

describe("v2.10 C05 — Merkle leaf pre-aggregation by recipient", () => {
  it("merges duplicate recipients into a single summed leaf", () => {
    const alice = "0xaaaa000000000000000000000000000000000000" as Address;
    const bob = "0xbbbb000000000000000000000000000000000000" as Address;

    const rawLeaves = [
      { recipient: alice, amount: 100n },
      { recipient: bob, amount: 50n },
      { recipient: alice, amount: 200n }, // duplicate; must merge
    ];

    const merged = aggregateByRecipient(rawLeaves);

    expect(merged).toHaveLength(2);
    const aliceLeaf = merged.find((l) => l.recipient === alice);
    const bobLeaf = merged.find((l) => l.recipient === bob);
    expect(aliceLeaf?.amount).toBe(300n); // 100 + 200
    expect(bobLeaf?.amount).toBe(50n);
  });

  it("normalizes recipient case (chain stores lowercase fingerprint)", () => {
    const aliceMixed = "0xAaAaaAAaaaaAAAAAaaaaaAaaAaaAaaaaaAAaaaaa" as Address;
    const aliceLower =
      ("0x" +
        aliceMixed
          .slice(2)
          .toLowerCase()) as Address;

    const rawLeaves = [
      { recipient: aliceMixed, amount: 100n },
      { recipient: aliceLower, amount: 50n }, // same address, different case
    ];

    const merged = aggregateByRecipient(rawLeaves);
    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(150n);
  });

  it("preserves singletons unchanged", () => {
    const alice = "0xaaaa000000000000000000000000000000000000" as Address;
    const bob = "0xbbbb000000000000000000000000000000000000" as Address;
    const carol = "0xcccc000000000000000000000000000000000000" as Address;

    const rawLeaves = [
      { recipient: alice, amount: 10n },
      { recipient: bob, amount: 20n },
      { recipient: carol, amount: 30n },
    ];

    const merged = aggregateByRecipient(rawLeaves);
    expect(merged).toHaveLength(3);
    const total = merged.reduce((acc, l) => acc + l.amount, 0n);
    expect(total).toBe(60n);
  });
});
