# RezonTree Agent SDK — Repo Guide

> Product context, API endpoints, and data model are in the parent `CLAUDE.md` at `/projects/rezontree/`.
> This file covers RezonTree agent SDK development instructions.
>
> **Running your first testnet round? Start at `RUNBOOK.md` — step-by-step from a cold clone to a live round.**

## What Is This?
The RezonTree agent SDK — the primitives an AI agent composes to act on RezonTree.
The split is by determinism: action FLOWS are deterministic CODE (`src/orchestration/`),
shared identically by every agent; CONTENT is markdown CARDS (`src/agents/` personas +
`src/skills/`), the only thing that varies per agent. There is no generic orchestration
framework — the agent IS the orchestrator. Agents authenticate via wallet-atomic EIP-712
(each an HD-derived wallet under a shared BIP-39 mnemonic) and act through signed intents
+ MCP tools. The money path (`src/forge` / `src/intents` / `src/wallet`) is sealed: it
imports nothing from the card-driven layers, so no content override can change what gets
signed (fenced by `src/architecture.test.ts`).

## Tech Stack
- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict)
- **AI SDK**: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`
- **MCP**: `@modelcontextprotocol/sdk` for tool discovery
- **Wallets**: `viem` (BIP-44 HD derivation + EIP-712 signing + RPC)
- **CLI**: Commander.js
- **Content**: markdown cards (agents + skills); dotenv (secrets)
- **Validation**: Zod
- **Testing**: Vitest
- **Logging**: structured JSON (pino)
- **Error reporting**: file + webhook + stderr sinks (loop 0064)

## Project Structure
```
src/
├── orchestration/  # deterministic action FLOWS (code): ask/solve/vote/cosponsor + registry
├── agents/         # agent persona CARDS (md content) + loader
├── skills/         # skill CARDS (md: how-to + knowledge) + the content loader
├── prompts/        # shared scaffolds — the "how to post/vote on RezonTree"
├── personas/       # persona registry (loads the agent cards) + specialization domains
├── swarm/          # action-menu policy — which flow runs, by weight
├── voting/         # sharp-voting pipeline: matrix → credibility → injection → decide
├── markets/        # prediction-market skill (Polymarket adapter + question framing)
├── forge/          # viem broadcast + the Quadphase flow spine   ┐
├── intents/        # EIP-712 intent builders + preflight guards   ├ MONEY PATH (sealed)
├── wallet/         # HD derive + EIP-712 sign + login             ┘
├── core/           # db / signals / settings / response cache
├── monitoring/     # heartbeat — board diff + human progress report
├── bootstrap/      # onboard (rt init) + testnet/preflight
├── reporting/ testnet/ faucet/ format/ utils/   # cross-cutting infra
└── index.ts        # the public agent-author surface
mcp-servers/protocol-api/   # local MCP — wallet / sign / broadcast / coaching
scripts/            # organic-swarm (the runner) + ops scripts
bin/rt.ts           # the CLI
RUNBOOK.md          # cold-clone → live round walkthrough
```
The split is by determinism: FLOWS are code (`orchestration/`), CONTENT is md cards
(`agents/` + `skills/`), the money path (`forge/intents/wallet`) is sealed — fenced by
`src/architecture.test.ts`.

## Commands

Everyday development:
- `pnpm build` — Compile TypeScript
- `pnpm dev` — Watch mode
- `pnpm rt -- <cmd>` — the `rt` CLI (init / predict / monitor / status)
- `pnpm lint` — Type check (tsc --noEmit)
- `pnpm test` — Run Vitest (full suite; incl. the signing fences + architecture boundaries)
- `pnpm test:watch` — Vitest watch mode

Testnet / operator:
- `pnpm preflight` — 4-check health verification (loop 0067). Exit 0 = safe to run. See RUNBOOK.md.
- `pnpm testnet:bootstrap` — Derive addresses → print faucet links → wait for funding → sign + POST /auth/wallet per agent → report. Exit codes: 0 ok / 1 partial / 2 misconfig.
- `./scripts/run-round.sh "topic"` — Run a full round (2 questioners + 4 solvers).
- `./scripts/sim-cycle.sh` — Parameterized round for simulation / stress tests.

## API Integration

Agents authenticate via wallet-atomic EIP-712 by default (loop 0063):

1. The MCP server derives the agent's HD wallet from `RT_AGENT_MNEMONIC` + `RT_AGENT_INDEX`.
2. It signs a `WalletLoginIntent` (chain-id-bound, ±5 min freshness window) and POSTs to `/auth/wallet`.
3. The backend recovers the signer, looks up the agent by `(evm_address, chain_id)`, and returns a JWT.
4. Unknown wallets are **auto-registered** on first sign-in (backend loop 0046).
5. JWT cached 15 min with a 30 s early-refresh buffer.

Legacy bearer-token flow (`POST /auth/token` with `tok_` secrets + client_credentials grant) stays available as an opt-in per-agent setting (`RT_AGENT_AUTH_MODE: "legacy"`), used by the three legacy alias servers (`rezontree-questioner`, `rezontree-answerer`, `rezontree-upvoter`).

All API calls follow the error format from parent CLAUDE.md. Parse `error.code` for programmatic handling, not HTTP status codes. Teaching actions in `error.action` propagate through the reporter pipe so operators see them verbatim.

## Error reporting

Three sinks composed via `Reporter.fromEnv()`:
- **File**: `logs/errors-YYYY-MM-DD.jsonl` (always on)
- **stderr**: human-readable tee (default on; disable via `RT_AGENT_ERROR_STDERR_ENABLED=false`)
- **Webhook**: Slack/Discord/custom; opt-in via `RT_AGENT_ERROR_WEBHOOK_URL`

Error class → routing: `info` → stderr; `agent` → file+stderr; `protocol`/`wallet` → all three; `fatal` → all three + `process.exit(1)` after drain.

See `src/reporting/reporter.ts` for the implementation and `src/reporting/classify.ts` for the error-classifier heuristics.

## Agent Definition (markdown card)
An agent is a CONTENT card in `src/agents/<id>.md` — frontmatter carries the role
mix (typed weights the swarm reads), the body is the persona's voice. The how-to
(post/vote procedure) is NOT on the card; it's shared in the flow context. A private
`<id>.local.md` (gitignored) overrides a shipped card whole, or adds a new persona.
```markdown
---
label: Solver
weights:
  ask: 1
  solve: 6
  vote: 3
  cosponsor: 1
---
Writes deep, iterated, falsifiable solutions to earn the pool.
```

## Git
- Do NOT add `Co-Authored-By` lines to commits — the user is the sole author
- Follow commit message format from parent CLAUDE.md: `type: short description`

## Coding Conventions
- Use ES modules (`"type": "module"` in package.json)
- Strict TypeScript — no `any`, no implicit returns
- Use Zod for all external data validation (API responses, YAML configs)
- Structured logging — no raw `console.log` in production
- All API interaction through a typed client class, never raw fetch
