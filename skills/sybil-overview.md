# Sybil Activity — Overview

> **You only run this skill if your role configuration says
> `mode: rogue` or `mode: sybil-operator`. Otherwise stay honest.**

The protocol cannot cryptographically block one operator running
multiple wallets — there's no identity at L1. The defense layers are:

1. **Audit logging** — when several wallets share an operator (e.g.,
   derived from one mnemonic), the harness flags the linkage in
   `sybilFindings`. Operators reviewing the round see the pattern.
2. **Reputation cost** — sybil patterns hurt long-run reputation.
   Linked wallets that consistently coordinate get downweighted on
   future rounds and routed fewer questions.
3. **Stake economics** — a sybil swarm still pays stake per wallet.
   If voters dominate honestly, the swarm loses its stakes.

Your job as a sybil-test agent is to **execute** these patterns
realistically — not to actually attack the protocol economically, but
to surface whether the audit + reputation defenses catch the linkage.

## Patterns to execute (one per skill file)

- `sybil-self-sponsor-vote.md` — sponsor a question, then vote on it
  through a linked wallet
- `sybil-coordinated-voting.md` — multiple linked wallets all back the
  same solver
- `sybil-cosponsor-then-solve.md` — sponsor early, then commit a
  solution to bias the pool toward your own answer
- `sybil-self-vote.md` — solver wallet's linked sybil votes for the
  solver's own solution

## How you identify yourself

Each sybil scenario takes specific role bindings — `controller`
(primary wallet), `arms` (linked wallets you control). The MCP tool
calls expose `RT_AGENT_INDEX` so each tool call is a distinct wallet
under the same shared mnemonic.

## What to log

Every sybil action you take should result in an audit-flag emitted by
the backend (or surfaced post-hoc via the harness's reconciliation).
Verify after each action:

```
GET /v1/admin/audit-log?query=sybil
```

If your linked-operator action lands but does NOT show up in the audit
log within 30 seconds, that's a finding (audit gap). Report it.

## What you DON'T do as a sybil agent

- You don't break protocol invariants (e.g., front-run signed intents,
  forge signatures, replay nonces). Those are *attack* patterns, not
  sybil patterns. They live in `attack-*.md` skills and have their
  own role bindings.
- You don't lie about your wallet identity. The contract verifies
  signatures; trying to pass another wallet's signature is just a
  revert, not a sybil pattern.
- You don't spam — sybil tests are about *coordinated linkage*, not
  *volume*.

## After your sybil session

Produce a report of what you did, in this shape:

```markdown
## Sybil session — <date>

**Pattern**: <one of: self-sponsor-vote / coordinated-voting / etc>
**Wallets used**: <list of HD indexes>
**Actions taken**: <ordered list with question_id + role>
**Expected audit findings**: <list of findings the harness should have logged>
**Verified findings**: <what `GET /v1/admin/audit-log` actually showed>
**Gap**: <findings expected but missing — these are bugs>
```

This report is the test result. It tells the operator what the protocol
caught, what it missed, and where the audit layer needs hardening.
