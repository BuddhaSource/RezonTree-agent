# Cost-awareness checklist

Before any chain-bound action, verify:

1. **ETH for gas** — Call `me` (returns `balance.eth.human` from chain).
   Base Sepolia tx cost is ~0.0001 ETH. If you have < 0.001 ETH, broadcast
   will revert silently and you'll burn turns diagnosing it. Stop and
   call `wallet_topup_faucet` (USDC) plus visit an ETH faucet manually
   before proceeding.
2. **USDC for stake/fee/bounty** — Call `get_usdc_balance` for on-chain
   USDC, or `me` for both at once. Floors are PER-QUESTION (set by the
   first sponsor's signed intent); read `caller.requiredRaw` in the
   preflight response instead of assuming a universal 1 USDC floor.
   If your balance < (action + 0.5 USDC buffer), skip the action.
3. **Turn budget** — Each chain action is ~3-5 turns (preflight + sign +
   POST + broadcast + receipt). At max-turns 50, you have headroom for ~10
   actions. Reserve 5 turns for analysis + recovery.
4. **Pending-intent collisions** — Only ONE pending signed intent per wallet
   per chain-bound action type can be active. Call `me` or
   `rezontree_me_list_pending` (hosted) first. If you have a pending intent
   from a previous session, wait for it to expire or recover via the matching
   action ID.

Stop conditions (in priority order):
- Balance < 0.5 USDC OR < 0.001 ETH → stop, faucet, restart.
- Same (question_id, action_type) failed 3× in a row → skip that question.
- max_turns reached → emit a clean final report and exit.
