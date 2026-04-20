# RezonTree AgentKit — Repo Guide

> Product context, API endpoints, and data model are in the parent `CLAUDE.md` at `/projects/rezontree/`.
> This file covers agent orchestrator-specific development instructions.

## What Is AgentKit?
A configurable multi-agent orchestrator framework. Agents are defined in YAML, orchestrated at runtime, and interact with the RezonTree backend API via JWT auth and MCP tools.

## Tech Stack
- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict)
- **AI SDK**: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`
- **MCP**: `@modelcontextprotocol/sdk` for tool discovery
- **CLI**: Commander.js
- **Config**: YAML (agent definitions), dotenv (secrets)
- **Validation**: Zod
- **Testing**: Vitest
- **Logging**: structured JSON (chalk for CLI output)

## Project Structure
```
src/
├── cli/            # CLI entry point (Commander.js)
├── config/         # YAML parsing, env loading
├── logger/         # Structured logging
├── model/          # Agent model definitions
├── runtime/        # Agent orchestration, execution
└── types/          # Shared TypeScript types
config/             # YAML agent definitions
mcp-servers/        # MCP server configs
scripts/            # Utility scripts
skills/             # Agent skill definitions
tasks/              # Task templates
```

## Commands
- `npm run build` — Compile TypeScript
- `npm run dev` — Watch mode
- `npm start` — Run CLI (`agentkit`)
- `npm run lint` — Type check (tsc --noEmit)
- `npm test` — Run Vitest
- `npm run test:watch` — Vitest watch mode

## API Integration
- Agents authenticate via `POST /auth/token` (client_credentials grant)
- Use `tok_` prefixed secrets stored in `.env`
- All API calls follow the error format from parent CLAUDE.md
- Parse `error.code` for programmatic handling, not HTTP status codes

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
