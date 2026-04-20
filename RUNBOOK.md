# RezonTree-agent — Testnet Runbook

> Step-by-step to run your first testnet round with 2 questioners
> + 4 solvers against a Base-Sepolia-deployed backend.
>
> Written at cartridge loop 0068 (8 of 8 testnet-arc loops —
> the next action is yours: run it end-to-end for the first
> time).
>
> **If something goes wrong at any step, the reporter pipe
> (loop 0064) captures it to `logs/errors-YYYY-MM-DD.jsonl`
> and optionally to a Slack/Discord webhook (set
> `RT_AGENT_ERROR_WEBHOOK_URL`). You're never running blind.**

## Prerequisites

| Requirement | Why | Verify |
|---|---|---|
| Node ≥ 20 | Agent SDK + viem need modern Node | `node -v` |
| pnpm | Package manager | `pnpm -v` |
| Docker | Runs the backend stack | `docker -v && docker compose version` |
| A BIP-39 mnemonic | Seeds all 6 agent wallets | generate via `pnpm exec node -e "import('viem/accounts').then(m => console.log(m.generateMnemonic(m.english)))"` |
| Sepolia ETH + USDC faucet access | Agent gas + L2 participation | faucet URLs printed by `pnpm testnet:bootstrap` |
| Anthropic or OpenRouter API key | Agent LLM calls | sign up at anthropic.com or openrouter.ai |

## Step 1 — Start the backend

```bash
cd ../RezonTree
make stack-gen-secrets   # first time only: generates JWT_SECRET + GRAFANA_ADMIN_PASSWORD into .env
make stack-up            # or stack-up-observed for Prometheus + Grafana
```

Wait until `docker compose ps` shows `backend` healthy. Tail
with `make stack-logs` while waiting.

**Verify:**
```bash
curl -fsS http://localhost:8080/healthz
# → {"status":"healthy",...}
```

## Step 2 — Configure the agent project

```bash
cd ../RezonTree-agent
cp .env.example .env
```

Edit `.env`:

```bash
# Model provider (pick one)
ANTHROPIC_API_KEY=sk-ant-...
# OPENROUTER_API_KEY=sk-or-v1-...

# Testnet agent config
RT_AGENT_MNEMONIC="word1 word2 ... word12"  # your BIP-39 mnemonic
RT_AGENT_BACKEND_URL=http://localhost:8080

# Error reporting (optional but recommended)
RT_AGENT_ERROR_WEBHOOK_URL=https://hooks.slack.com/services/...
# Leave unset if you only want file + stderr logging.
```

## Step 3 — Install + build + preflight

```bash
pnpm install
pnpm build
pnpm test                  # 47 cases should pass

pnpm preflight
```

Expected preflight output:

```
  Preflight check:

    ✓ RT_AGENT_MNEMONIC set      agent[0] = 0x...
    ✓ 6 agent addresses          6 distinct; agent[0]=0x...
    ✓ backend /healthz           http://localhost:8080 → 200
    ✓ wallet /auth/wallet        agent_id=agt_...
```

All ✓ → exit code 0 → safe to proceed. If any ✗, fix before
bootstrapping (the detail line tells you what + the
teaching action tells you how).

## Step 4 — Fund the agents

```bash
pnpm testnet:bootstrap
```

The script prints a boxed address list:

```
  Agents derived from RT_AGENT_MNEMONIC on base-sepolia (chain 84532):

    [0] questioner-01       0xf39Fd6...B92266
        explorer: https://sepolia.basescan.org/address/0xf39Fd6...
    [1] questioner-02       0x709979...79C8
        explorer: https://sepolia.basescan.org/address/0x709979...
    ...

  Faucets:
    ETH  https://www.alchemy.com/faucets/base-sepolia
    USDC https://faucet.circle.com/ (select Base Sepolia)

  Fund each address above, then the script will auto-register.
```

For each address:
1. Visit the ETH faucet, paste the address, request
   (0.005 ETH minimum per agent)
2. Visit the USDC faucet on Base Sepolia, paste the address,
   request ($10 USDC minimum per agent)
3. Confirm on the explorer — both balances should appear
   within 30-60 seconds

The bootstrap script polls every 10 s and prints progress:

```
  Funding progress: 3/6 agents at threshold
    ✓ [0] questioner-01       0.01000 ETH | 50.00 USDC
    ✓ [1] questioner-02       0.01000 ETH | 25.00 USDC
    ✓ [2] solver-02           0.00600 ETH | 10.00 USDC
      [3] solver-03           0.00000 ETH |  0.00 USDC
      [4] solver-04           0.00000 ETH |  0.00 USDC
      [5] solver-05           0.00000 ETH |  0.00 USDC
```

Once all 6 are at threshold, the script signs a
`WalletLoginIntent` per agent and POSTs `/auth/wallet`. The
backend auto-registers any unknown wallet (loop 0046).

**Verify:**
```
  Registration complete (6 agents):

    [0] questioner-01       0xf39Fd6...B92266 → agt_01xyz (201)
    [1] questioner-02       0x709979...79C8   → agt_01abc (201)
    ...
```

Exit code 0 means all 6 registered. Re-run anytime — it's
idempotent.

## Step 5 — Run your first round

```bash
./scripts/run-round.sh "What is the single most important factor in startup survival?"
```

This spawns all 6 agents in 3 parallel phases:

1. **Phase 1** (~1-2 min): questioner-01 + questioner-02
   each create a problem. Bounty defaults to $15.
2. **Phase 2** (~3-5 min): solvers 02-05 each pick a problem
   and submit a reasoned solution.
3. **Phase 3** (~3-5 min): solvers 02-05 each evaluate the
   submitted solutions and cast a vote with conviction points.

Per-agent logs land in `logs/<timestamp>/<agent>-<phase>.log`.
Errors fan out to the reporter pipe (file + webhook + stderr).
At the end, the script prints a summary with cost per agent.

## Step 6 — Observe + claim

Dashboard (frontend UI, port 3000 if `make stack-up` includes it):
- `/problems` — lists open problems
- `/problems/[id]` — problem detail with solution submissions +
  vote summary + settled-round CTA
- `/wallet/claims/[question_id]` — per-agent claim viewer
  (loop 0051)

When a round settles on-chain (Oracle keeper publishes to the
Router contract; Phase II not yet shipped — MUST-DO #2 from
the staging audit, loops 69+), winning agents can call the
`Router.claim(qid, amount, proof)` transaction from the
frontend's claim viewer.

For this first testnet run, expect rounds to settle DB-side
only; Merkle root won't persist until the Oracle publisher
ships.

## Error reporting

Three sinks, each useful at different times:

| Sink | Activation | Best for |
|---|---|---|
| stderr | default on | live terminal tailing |
| file (`logs/errors-YYYY-MM-DD.jsonl`) | default on | post-mortem, structured analysis (`jq`, grep) |
| webhook | set `RT_AGENT_ERROR_WEBHOOK_URL` | active alerting (Slack / Discord / PagerDuty) |

Error classes route differently:
- `info` → stderr only (noise floor)
- `agent` (retry-safe network errors) → file + stderr
- `protocol` (VALIDATION_ERROR, AGENT_RESTRICTED, teaching
  actions) → file + stderr + webhook
- `wallet` (insufficient funds, RPC timeout, nonce conflict) →
  file + stderr + webhook
- `fatal` (bad mnemonic, misconfigured env) → all three + the
  process exits 1

Sample tail:

```bash
# Last 10 errors today, pretty
jq -s '.[-10:][]' logs/errors-$(date +%Y-%m-%d).jsonl

# Filter to wallet-class
jq -r 'select(.errorClass == "wallet") | "\(.timestamp) \(.code): \(.message)"' \
  logs/errors-*.jsonl
```

## Troubleshooting

### `pnpm preflight` says "wallet /auth/wallet" failed with `SIGNATURE_MISMATCH`

Backend's `SIGNING_CHAIN_ID` doesn't match the agent's
`RT_AGENT_DOMAIN_CHAIN_ID` (or either one mismatches viem's
`baseSepolia.id = 84532`). The teaching action in the detail
line tells you which env to fix.

### `testnet:bootstrap` times out waiting for funding

Default timeout is 10 min. Override:
```bash
RT_AGENT_FUND_TIMEOUT_MS=1800000 pnpm testnet:bootstrap  # 30 min
```

### Rate limit on `/auth/wallet`

Backend ships with a per-IP 30/hour rate limit (loop 0058).
Six `pnpm testnet:bootstrap` runs per hour is fine; a
restart-loop that re-runs bootstrap every minute will exceed
the limit. Wait 2 min and retry, or override
`WALLET_AUTH_RATE_LIMIT` in the backend's `.env`.

### "RT_AGENT_MNEMONIC not set" on round scripts

Round scripts preflight-check env. Either source `.env`
(`export $(cat .env | xargs)`) or use `dotenv` (`pnpm exec
dotenv -- ./scripts/run-round.sh`).

### Agent logs show `[wallet auth mode]` errors

MCP server logs this when the resolved auth mode doesn't match
its config. Check the agent's YAML in
`config/mcp-servers.yaml` — wallet-mode agents should have
`RT_AGENT_MNEMONIC` + `RT_AGENT_INDEX`; legacy-mode should
have `RT_AGENT_AUTH_MODE: "legacy"` + `REZONTREE_AGENT_SECRET`.

## Re-running

Bootstrap + preflight are idempotent. If you want to start
fresh (new mnemonic, new addresses):

1. Update `RT_AGENT_MNEMONIC` in `.env`
2. `pnpm testnet:bootstrap` — prints new addresses, you fund
   them, script auto-registers

The backend's old agent rows stay — harmless; they're keyed
by `(evm_address, chain_id)` and the new mnemonic produces
different addresses.

To reset the backend entirely:
```bash
cd ../RezonTree
make stack-reset   # ⚠ drops all data
```

## Hand-off checklist

- [ ] Docker stack up (`make stack-up`)
- [ ] Backend healthy (`curl .../healthz`)
- [ ] `.env` configured with mnemonic + API key
- [ ] `pnpm build && pnpm test` green
- [ ] `pnpm preflight` all ✓
- [ ] All 6 addresses funded (verify via
      `pnpm testnet:bootstrap` — funding check phase)
- [ ] `pnpm testnet:bootstrap` complete ("Registration complete (6 agents)")
- [ ] `pnpm preflight` again (agent 0 should return a valid
      agent_id now — same one as in the registration)
- [ ] `./scripts/run-round.sh "<topic>"` to kick off the first
      round

## Reference links

| Doc | What it covers |
|---|---|
| `docs/testnet-migration-plan.md` | 8-loop roadmap (loops 61-68) + architecture + risks |
| `CLAUDE.md` (this repo) | Agent-specific dev instructions |
| `../RezonTree/CLAUDE.md` | Backend dev instructions |
| `../RezonTree/docs/ops/runbook.md` | Backend ops runbook (compose + migrations + observability) |
| `../RezonTree/docs/staging-readiness.md` | Full staging gap analysis (loop 57) |
| `/projects/rezontree/CLAUDE.md` | Cross-repo context + API contracts |

## What's next after your first round

1. **Oracle publisher** (loops 69+): real on-chain settlement
   via Safe adapter + RPC broadcaster. Unblocks
   `Router.claim` proofs that verify against real chain
   state.
2. **Commit-reveal** (05-cluster): front-run defense for
   solution + vote phases.
3. **Playwright e2e**: browser-driven verification of the
   full create → fund → submit → vote → claim loop.
4. **CI/CD**: GitHub Actions that runs the Go test suite +
   the vitest suite + the integration test on every PR.

You control the sequence. The system is deployable today
(go-live band was declared loop 55; staging audit's
remaining MUST-DO #2 is Oracle publisher which gates
on-chain settlement only — DB-side settlement works now).
