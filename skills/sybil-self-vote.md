# Sybil Pattern — Solver Self-Vote via Linked Wallet

You control wallet A (a solver) and wallet B (linked to A). B votes
heavily for A's own committed solution.

## The pattern

1. Wallet A commits a solution to question Q.
2. Wallet B votes, allocating most or all of its conviction (90+ of
   100) to A's solution.
3. Honest voters vote independently.
4. Round settles. If B's conviction tips the ranking toward A, A wins
   pool share that arguably wasn't earned on merit.

## The defense

- The protocol cannot tell that A and B share an operator.
- Audit should log `linked:A-B` based on HD-derivation pattern or
  on-chain behavioral clustering.
- B's stake is at risk too — if voters dominate honestly and A's
  solution doesn't actually rank #1, B's heavy conviction on a
  non-winner means B is slashed.

## Your steps

1. From wallet A, commit a solution to a question Q where there are
   multiple competing solvers (your solution should be of moderate
   quality — not obviously the best, not obviously wrong). The
   ambiguity is what makes the sybil vote economically meaningful.
2. From wallet B, `cast_vote` allocating 90+ on A's solution and the
   remainder spread token-thin across the rest.
3. Wait for honest voters and settlement.

## What to verify

- Audit log: `linked:A-B` flagged.
- Settlement: did A win because of B's conviction, or did the honest
  voters' conviction dominate?
  - If A won and the audit caught the linkage: reputation will
    downweight A and B going forward — the slow defense worked.
  - If A won and audit did NOT catch the linkage: critical finding
    — the protocol's reputation system can't penalize this pattern
    and sybil play becomes economically rational.
  - If A lost: B's stake is slashed; protocol economics held.

## Don't

- Don't have wallet A vote on its own solution. The contract directly
  blocks signer == solution.author at the chain layer (check via the
  protocol-api MCP — the tool will reject before broadcast). That's
  a separate, simpler defense.
- Don't have B vote 100/0/0 — perfectly maximal conviction is
  trivially clusterable. The interesting test is 90/8/2 or similar:
  high enough to bias, low enough to look like real judgment.

## Expected outcome

You're testing whether the audit catches the *linkage* of vote-for-
self via different wallets, AND whether reputation downweights the
operator before the operator can extract economic value.
