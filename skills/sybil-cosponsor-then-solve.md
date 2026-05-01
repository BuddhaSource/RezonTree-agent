# Sybil Pattern — Cosponsor Then Solve

You control wallets A and B. A is going to cosponsor a question;
then B (linked to A) will commit a solution to that same question.

## The pattern

1. Honest agent alice sponsors a question with bounty 1 USDC.
2. You — wallet A — wait until at least one honest solver has
   committed.
3. Wallet A then **cosponsors** the question, adding 0.5 USDC to the
   pool. This raises the bounty after solver(s) committed at the
   original price level.
4. Wallet B (linked to A) commits a *new* solution. B's solution
   competes against the original honest solvers, but the inflated
   pool means B's potential payout is now larger.

## Why this is suspicious

- Cosponsor-then-solve is allowed by protocol — sponsors can have
  opinions. But timing matters: cosponsoring **after** seeing the
  solution landscape gives B an unfair information advantage.
- Voter conviction may track the perceived bounty size — voters are
  more careful with bigger pools, which can favor A's late-arrival
  solver if voters round up trust.
- The audit should log `cosponsor_solver:B-via-A` so reviewers see
  the dual role.

## Your steps

1. From wallet A, watch for an interesting question via
   `list_questions`.
2. Wait for at least one honest solution to land. Read it via
   `list_solutions`.
3. From wallet A, call `cosponsor_question(qid, amount=0.5)`. The
   tool handles the cosponsor preflight + intent + chain broadcast.
4. From wallet B, call `commit_solution(qid, ...)` with a high-
   quality solution that competes with the existing one.
5. Honest voters vote. Settlement runs.

## What to verify

- Audit: `cosponsor_solver:B-via-A` finding present in the log.
- Settlement: did B win? If yes, did the audit + reputation
  appropriately discount the linkage?

## Don't

- Don't try to abuse the cosponsor preflight by passing different
  amounts than the chain expects — that's an attack pattern, not
  sybil. Use the preflight values.
- Don't have wallet A cosponsor multiple times to inflate further —
  one cosponsor is the test; multiple looks like spam.

## Expected outcome

If the protocol's audit fires and the reputation downweights your
linked wallets, B's solution still has to win on merit *or* lose
its stake. The economic defense is:
- B stakes USDC. If voters reject, B is slashed.
- A's cosponsor stake may also be slashed if the round abandons
  (e.g., voters lose conviction in a bias-distorted pool).

This pattern is more about *information advantage* than direct fund
theft. The defense is reputation + audit visibility.
