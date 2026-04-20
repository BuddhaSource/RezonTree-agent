# RezonTree AgentKit — Repo Guide

> Product context, API endpoints, and data model are in the parent `CLAUDE.md` at `/projects/rezontree/`.
> This file covers agent orchestrator-specific development instructions.
>
> **Running your first testnet round? Start at `RUNBOOK.md` — step-by-step from a cold clone to a live round.**

## What Is AgentKit?
A configurable multi-agent orchestrator framework. Agents are defined in YAML, orchestrated at runtime, and interact with the RezonTree backend API via wallet-atomic EIP-712 auth and MCP tools. Each agent is an HD-derived wallet under a shared BIP-39 mnemonic.

## Tech Stack
- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict)
- **AI SDK**: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`
- **MCP**: `@modelcontextprotocol/sdk` for tool discovery
- **Wallets**: `viem` (BIP-44 HD derivation + EIP-712 signing + RPC)
- **CLI**: Commander.js
- **Config**: YAML (agent definitions), dotenv (secrets)
- **Validation**: Zod
- **Testing**: Vitest
- **Logging**: structured JSON (chalk for CLI output)
- **Error reporting**: file + webhook + stderr sinks (loop 0064)

## Project Structure
```
src/
├── bootstrap/      # Testnet orchestrators (loop 0065+): testnet, preflight, formatter
├── cli/            # CLI entry point (Commander.js)
├── config/         # YAML parsing, env loading
├── logger/         # Structured logging (stdout JSON)
├── model/          # Agent model definitions
├── reporting/      # Error reporting pipe — file/webhook/stderr sinks (loop 0064)
├── runtime/        # Agent orchestration, execution
├── testnet/        # Testnet chain config (Base Sepolia)
├── types/          # Shared TypeScript types
└── wallet/         # HD derive + EIP-712 sign + balance query (loop 0062)
config/             # YAML agent definitions
docs/
├── testnet-migration-plan.md  # 8-loop testnet-ready roadmap
mcp-servers/        # MCP server configs (wallet-mode auth by default, loop 0063)
scripts/            # Shell utilities (bootstrap legacy, run-round, sim-cycle)
skills/             # Agent skill definitions
tasks/              # Task templates
RUNBOOK.md          # Step-by-step testnet round walkthrough (loop 0068)
```

## Commands

Everyday development:
- `pnpm build` — Compile TypeScript
- `pnpm dev` — Watch mode
- `pnpm start` — Run CLI (`agentkit`)
- `pnpm lint` — Type check (tsc --noEmit)
- `pnpm test` — Run Vitest (47 cases across wallet / reporting / bootstrap)
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

## Agent Definition (YAML)
Agents are defined as YAML configs in `config/`:
```yaml
name: solver-agent
description: Submits solutions to open problems
capabilities:
  - problem_solving
  - code_generation
model: claude-sonnet-4-6
tools:
  - rezontree-api
  - code-executor
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
