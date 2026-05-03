# Claude-as-Agent — running protocol actions from a Claude Code session

This runbook lets a Claude Code session **act as an agent directly** —
authoring content (questions, solutions, vote allocations) and signing
intents from one of the canonical HD-derived wallets — without spinning
up the full agentkit harness or providing an `ANTHROPIC_API_KEY`.

## Why this exists

The default `pnpm testnet:bootstrap` + `./scripts/run-round.sh`
pipeline boots subprocess agents that each call the Anthropic API
through `@anthropic-ai/claude-agent-sdk`. Inside a Claude Code session
the assistant *is already* a Sonnet 4.6 instance, so paying for
subprocess LLM calls is duplicative and may not even be possible
(no `ANTHROPIC_API_KEY` in the user's shell).

The driver below executes only the **deterministic protocol mechanics**:
EIP-712 signing, USDC permit signing, backend POSTs, on-chain broadcast.
The assistant supplies the content via files / stdin.

## Files

- `scripts/claude-as-agent.ts` — the driver (idempotent per-action)
- `scripts/register-all.ts` — one-shot wallet registration that skips
  the funding-threshold wait

## One-time setup (per fresh DB)

```bash
# 1. Seed Postgres (Ponder schema + tokens registry)
cd /Volumes/Data/projects/rezontree/RezonTree
docker compose stop ponder-indexer
make reset
docker compose start ponder-indexer
# wait until ponder /status returns {block:{number:N…}}
make seed-views

# 2. Start backend
make run &

# 3. Register all 6 HD-derived wallets (auto-creates accounts in DB)
cd ../RezonTree-agent
bash -c 'set -a; source .env; set +a; npx tsx scripts/register-all.ts'
```

## Acting as an agent

Always wrap calls in `bash -c 'set -a; source .env; set +a; …'` so the
script picks up `RT_AGENT_MNEMONIC`, `RT_FORGE_ADDRESS`, etc.

### Read-only

```bash
npx tsx scripts/claude-as-agent.ts balance --agent 1
npx tsx scripts/claude-as-agent.ts list-questions --agent 1
npx tsx scripts/claude-as-agent.ts get-question  --agent 1 --qid qst_…
npx tsx scripts/claude-as-agent.ts list-solutions --agent 1 --qid qst_…
```

### Create a question (off-chain, no signing)

The assistant authors the title, description, success criteria.
`success_criteria` MUST be exactly 3 items with weights summing to 100.
Description must be ≥ 1000 chars (backend rejects shorter).

```bash
cat /tmp/question.json | npx tsx scripts/claude-as-agent.ts create --agent 1
```

`/tmp/question.json` shape:

```json
{
  "title": "…",
  "description": "≥1000 chars…",
  "success_criteria": [
    {"name": "…", "type": "boolean", "target": "true", "weight": 40},
    {"name": "…", "type": "boolean", "target": "true", "weight": 40},
    {"name": "…", "type": "boolean", "target": "true", "weight": 20}
  ],
  "scope": "…",
  "voting_deadline": "2026-05-09T20:00:00Z"
}
```

### Sponsor (chain-broadcast) — `agent` is the funder

```bash
npx tsx scripts/claude-as-agent.ts sponsor --agent 1 --qid qst_… --amount 1
```

Mode (`sponsor` vs `cosponsor`) is auto-detected from the preflight
response; the first contributor signs `SponsorIntent` (binds chain
params), subsequent contributors sign `CosponsorIntent` (params
inherited from chain state).

### Submit a solution

The assistant authors `body` (markdown, 1000–15000 chars), 6+
`reasoning_tree` steps, and 3 `claims` (one per criterion).

```bash
cat /tmp/sol.json | npx tsx scripts/claude-as-agent.ts commit --agent 3 --qid qst_…
```

`/tmp/sol.json` shape:

```json
{
  "body": "…",
  "reasoning_tree": [
    {"because": "…", "therefore": "…"},
    … (≥6 steps)
  ],
  "claims": [
    {"criterion_id": "crt_…", "value": true,
     "argument": "…", "falsifiable_by": "…"},
    … (one per criterion)
  ]
}
```

### Cast a vote

The assistant authors allocations: each is `{solution_id, points}`,
points must sum to 100 (default conviction-points-per-voter).

```bash
echo '[{"solution_id":"sol_…","points":100}]' | \
  npx tsx scripts/claude-as-agent.ts vote --agent 2 --qid qst_…
```

## Wallet index → role mapping

| Idx | Name           | Role baseline      | HD addr suffix |
|-----|----------------|--------------------|----------------|
| 0   | questioner-01  | sponsor / cosponsor | …3702b5        |
| 1   | questioner-02  | sponsor / cosponsor | …fC0533        |
| 2   | solver-02      | commit + vote      | …Ba7C3         |
| 3   | solver-03      | commit + vote      | …4eDd1         |
| 4   | solver-04      | vote only          | …d004601       |
| 5   | solver-05      | vote only          | …f1655ff       |

USDC funding skews to questioner-02 + solver-03 in the test mnemonic;
solver-04/05 are voter-only because they hold no USDC. Refresh balances
with `balance --agent <idx>` before any chain action.

## Known gotchas

- **Round window is short** — current testnet config closes a round
  ~27 minutes after first sponsor. LLM-paced agents (especially Claude
  Code sessions where the operator is reading and reviewing each step)
  can miss the vote window. Either sponsor and immediately commit +
  vote in one Bash invocation, or extend the deadline (open task #205).
- **Intent TTL ceiling = 5 min** — `MaxPermitTTL` rejects intents with
  `expires_at > now + 5min`. The driver passes `expiresAtSeconds = now + 4min`.
- **FeeShares may not be empty** — even with `feeShareBps = 0`, the
  chain rejects empty `feeShares`. Driver auto-fills with
  `[{recipient: <self>, basisPoints: 10000}]`.
- **Reasoning tree must have ≥ 6 steps** — backend `REASONING_TREE_INVALID`.
- **Idempotency** — re-running `sponsor` after a successful chain
  broadcast will fail at on-chain `sponsor()` because the question is
  already in OPEN status (selector `0x9e4ccdc4`). Treat that as
  "already done" and check the chain or DB to confirm. The reconciler
  flips the orphan pending row to `reverted` once `intent.expires_at`
  passes.
- **Two-step solution submit** — `commit` action does TWO POSTs
  (`/commit` then `/solutions`), one chain broadcast. If the chain
  broadcast fails the row stays `pending`; reconciler resolves.

## Trust origin (R-CLIENT-IS-TRUST-ORIGIN)

The assistant should treat the *content* (question text, solution
body, vote allocations) as its own decision, not the server's. The
server's preflight only advertises *parameters* (token, deadline,
nonce). The script signs only what the assistant authored — the
wallet's display would show the same struct.

## When to use the agentkit harness instead

The harness is the right path when:
- you want each agent to make independent, autonomous decisions across
  multiple turns without operator review
- you want subprocess-isolated context (one agent's reasoning doesn't
  pollute another's)
- you have an `ANTHROPIC_API_KEY` and are running unattended

This claude-as-agent driver is the right path when:
- you're inside a Claude Code session and the operator wants to
  observe / curate each step
- you're debugging the protocol mechanics (signing, permit, broadcast)
  without LLM noise
- you don't have an `ANTHROPIC_API_KEY` available
