# Sybil Pattern — Self-Sponsor + Self-Vote

You control wallets A, B, C — all derived from the same mnemonic. The
operator running you is the same person.

## The pattern

1. Wallet A sponsors a question — bounty 1 USDC, ordinary parameters.
2. Wallets B and C wait for solvers to commit. Honest voters carol +
   grace are also voting.
3. Once solutions are visible, wallet B (your sybil) votes heavily
   for the solution you (the operator) want to win — typically a
   solution that wallet A's sponsor *wouldn't* want chosen on merit.
4. Wallet C (also your sybil) reinforces the same vote.

## Why this is a sybil pattern

- One operator, three signatures, three economic stakes. The chain
  sees three independent wallets.
- The protocol cannot tell the wallets are linked.
- The audit log SHOULD detect the linkage from shared-mnemonic HD
  derivation patterns and flag `linked:A-B-C`.

## Your steps

1. Use `sponsor_question` from wallet A. Make it a real, fair
   question — pose something that an honest solver would engage with.
2. Wait for at least one solution to land (use `list_solutions` to
   poll).
3. From wallet B, `cast_vote` allocating high conviction on
   *one specific* solution (your choice as operator).
4. From wallet C, do the same vote pattern.
5. Wait for settlement.

## What to verify after

- Backend's audit log should record the linkage. Pull it via the
  MCP tool `read_audit_log` (or `GET /v1/admin/audit-log` with admin
  scope).
- The harness's `sybilFindings` array should include
  `linked:A-B-C`.
- The honest voters' conviction should still dominate the ranking
  IF carol + grace's combined points exceed B+C's combined points.
  This is the protocol's economic defense.

## Don't

- Don't have wallet A vote on its own sponsored question — that's a
  separate pattern (sponsor-self-vote, much more egregious; the
  protocol may catch it directly via signer == sponsor checks).
- Don't have any sybil wallet vote on its own committed solution —
  that's `sybil-self-vote.md`.
- Don't try to make B and C's signatures *look* like different
  operators. The honest sybil test exposes the linkage; obfuscation
  defeats the test.

## Expected outcome

If the audit catches the linkage and the honest voters' conviction
dominates, the round settles correctly *and* the linkage is visible
post-hoc. **That's the protocol working.**

If the audit silently misses the linkage, that's a finding worth
reporting — it means the protocol's reputation system can't penalize
the operator long-run, and sybil play becomes economically rational
over time.
