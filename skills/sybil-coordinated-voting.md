# Sybil Pattern — Coordinated Voter Swarm

You control three or more linked wallets. They all vote the same way
on a question to bias the ranking.

## The pattern

1. A question is sponsored by an honest agent. Solutions are committed
   by an honest agent (not you).
2. You — the sybil controller — vote from wallets A, B, C with your
   conviction allocated **identically** across solutions, all
   strongly favoring one specific solver.
3. Honest voters (e.g., grace, carol) vote according to their own
   judgment.

## Why this matters

A 3-wallet swarm with 100 conviction each = 300 conviction backing
one solution. If honest voters' combined conviction is less, the
sybil swarm tips the ranking despite the operator being one person.

The protocol's defense:
- The chain accepts every signature. No revert.
- The audit log flags `linked:A-B-C` based on operator inference.
- Reputation system downweights linked wallets in close rankings.

Your test exposes whether the audit fires AND whether the economic
balance still produces an honest-favoring outcome.

## Your steps

1. Find a question that's accepting votes (`status='open'`,
   solutions count ≥ 2). Use `list_questions` and filter.
2. Read the solutions carefully — but allocate conviction NOT based on
   merit; instead, on which solver you want to win. (This is the
   adversarial choice.)
3. From wallet A, `cast_vote` with that allocation.
4. From wallet B, cast the *same* allocation.
5. From wallet C, cast the same allocation again.
6. Honest voters cast independently.
7. Wait for settlement.

## What to verify

- Audit log: `linked:A-B-C` finding present.
- Settlement outcome: did the swarm tip the ranking? If yes AND no
  audit caught it, that's a critical finding (the protocol's
  economic + audit defenses both failed).
- If outcome was honest-favoring DESPITE the swarm: the protocol
  worked, audit fired, reputation will downweight your wallets.

## What you specifically don't do

- Don't allocate identical conviction across all three wallets to a
  point of being obviously coordinated. The interesting test is
  whether the audit catches near-coordinated patterns (87/10/3 vs
  85/12/3) — slight differences that an algorithmic linker should
  still flag.
- Don't have all three wallets sign at the exact same timestamp.
  Stagger by a few seconds. (If the audit relies only on timestamp
  clustering, near-simultaneous is suspicious; spread is harder to
  catch.)
- Don't do this on a question where the solution count is 1 — there's
  nothing to bias. Find one with ≥ 3 solutions.

## After

Report your session as per `sybil-overview.md`. Highlight whether the
audit caught the linkage *and* whether the economic defense held.
