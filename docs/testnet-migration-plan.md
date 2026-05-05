# RezonTree-agent — Testnet Migration Plan

> Cartridge loop 0061. Maps the multi-loop path from the
> current email/password + bearer-token agent model to a
> **wallet-atomic EIP-712** model that works against the new
> backend and is ready to run on Base Sepolia testnet.

## Why we're migrating

The existing agent project (`/Volumes/Data/projects/rezontree/
RezonTree-agent/`) was built against the OLD backend where:
- Agents registered via email/password + were given `tok_`-
  prefixed bearer secrets.
- Wallets were an internal USD ledger entry, not an on-chain
  address.
- `bootstrap.sh` wrote agent rows directly into Postgres via
  `psql` + called `/v1/wallet/deposit` with USD amounts.

The NEW backend (since the atomic-agent scope at loop 38):
- Agents ARE their EVM wallet — `(evm_address, chain_id)` is
  the primary identity.
- Auth is `POST /auth/wallet` with an EIP-712-signed
  `WalletLoginIntent`; auto-register on first sign-in.
- Fund flow involves real on-chain tokens on Base Sepolia
  (chain_id 84532). Claim viewer / settlement ends with an
  agent (or any executor on its behalf) submitting
  `RezonForge.claim(qid, recipient, amount, proof)` —
  `recipient` is the Merkle-leaf payee.

Bearer-token auth still exists (the `/auth/token` endpoint for
legacy client-credential flows) but it's second-class for new
agents. The wallet-login path is the one staging will exercise.

## What we keep vs replace

### Keep (value intact)
- `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/sdk` runtime
- Commander CLI + YAML config + dotenv patterns
- Structured logging (`src/logger/`)
- Skills framework (`skills/reasoning.md`, `skills/structured-output.md`)
- MCP server shape (stdio-based, one per agent)
- vitest test infrastructure
- Agent orchestration runtime (`src/runtime/`)

### Replace
- Bearer-token auth in the MCP server → wallet-EIP-712 auth
- `bootstrap.sh`'s psql-direct-write + /auth/register → wallet
  derivation + /auth/wallet auto-register
- `.env`'s `REZONTREE_AGENT_SECRET` per agent → wallet mnemonic
  + per-agent HD path
- `/v1/wallet/deposit` calls (USD-only) → on-chain deposit
  tracking (read-only view of ETH + USDC balance)

### Add
- **`src/wallet/`** package: HD key derivation, EIP-712 signing,
  balance queries against Base Sepolia RPC
- **`src/testnet/`** package: RPC config, chain metadata,
  USDC contract address, block explorer links
- **`src/reporting/`** package: error-reporting pipe (file log +
  optional webhook) for the user's "monitor and fix" loop
- **`scripts/testnet-bootstrap.sh`**: derive N agents from
  mnemonic, print addresses for the user to fund, wait for
  on-chain balance, auto-register via /auth/wallet
- **`scripts/testnet-fund-status.sh`**: one-shot balance check
  for all configured agents (ETH + USDC)
- **`config/testnet.yaml`**: single-source testnet config (RPC,
  chain ID, USDC address, backend URL)

## Multi-loop plan

| Loop | Target | Output |
|------|--------|--------|
| **61** (this) | Audit + plan + wallet package scaffold + dep install | This doc + `src/wallet/` types + viem in package.json |
| 62 | Wallet package implementation | HD derivation, EIP-712 signing of `WalletLoginIntent`, balance query, testnet.yaml |
| 63 | MCP server refactor for wallet-login | `mcp-servers/protocol-api/server.ts` signs + posts /auth/wallet instead of client_credentials |
| 64 | Error reporting pipe | `src/reporting/` with file + webhook sinks; wired to runtime's error boundaries |
| 65 | Testnet bootstrap script | `scripts/testnet-bootstrap.sh` derives + prints funding addresses + waits for balance + auto-registers |
| 66 | Refit run-round.sh + sim-cycle.sh for the new flow | Scripts call testnet-bootstrap first; round logic unchanged |
| 67 | End-to-end dry-run against a LOCAL stack | Verify 2 questioners + 4 solvers complete a round on local backend |
| 68 | Testnet-ready packaging + docs | Final runbook; confirm staging compose + testnet mode play nice |
| 69 | **HAND-OFF** — user-triggered first testnet run | Not a loop; wait for user's "run it" |

Target: by loop 68, the user can run:

```bash
make -C ../RezonTree stack-up-observed   # local backend + observability
cd ../RezonTree-agent
pnpm testnet-bootstrap    # prints addresses; waits for funding
pnpm run-round            # 2 questioners + 4 solvers; full Q&A cycle
```

…against Base Sepolia, with errors funneling into the reporting
pipe where a supervising agent (or the user's inbox) can see
them and fix.

## Wallet derivation design

**HD path scheme** (BIP-44):
```
m / 44' / 60' / 0' / 0 / <agent_index>
```

- `44'`: BIP-44 purpose
- `60'`: Ethereum coin type
- `0'`: account 0
- `0`: external chain (receiving)
- `<agent_index>`: 0..N for each agent defined in YAML

One mnemonic controls N agents. Single backup phrase, N
addresses. User funds addresses independently on testnet.

**Secret handling**:
- Mnemonic lives in `.env` as `RT_AGENT_MNEMONIC` (never
  committed; `.env.example` holds a placeholder)
- Private keys derived in-memory at agent startup; never
  persisted
- Signer lives in `src/wallet/signer.ts` with the full
  `WalletLoginIntent` EIP-712 type set matching the backend's
  `internal/signer/wallet_login_intent.go`

## Error reporting design

Requirement: "errors logged and reported somewhere so that our
agent can simply monitor and fix them."

Three sinks, composable via config:

1. **File sink** (default-on): one JSONL-per-day file at
   `logs/errors-YYYY-MM-DD.jsonl`. Each entry: timestamp,
   agent_id, error.code (if AppError), error.message, action,
   request_id, stack (if TypeError).
2. **Webhook sink** (opt-in): POST to configured URL
   (Slack-compatible, Discord-compatible, or custom). Batched
   with 5-second debounce to avoid floods.
3. **stderr sink** (default-on in dev): tee to `process.stderr`
   in human-readable format.

Error taxonomy:
- **Agent-layer** (network, retry-safe): logged, not reported
- **Protocol-layer** (VALIDATION_ERROR, AGENT_RESTRICTED, etc.):
  logged, reported to webhook
- **Wallet-layer** (insufficient funds, nonce conflict, RPC
  timeout): logged, reported to webhook, retry-with-backoff
- **Fatal** (misconfigured mnemonic, bad RPC URL): exit 1
  after logging

## Testnet config

Base Sepolia (chain_id 84532):
- RPC: https://sepolia.base.org (public; operators can
  override via `RT_AGENT_RPC_URL`)
- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Base
  Sepolia USDC per Circle's registry)
- Block explorer: https://sepolia.basescan.org/
- Faucet pointer: https://www.alchemy.com/faucets/base-sepolia
  (for Sepolia ETH); USDC-sepolia faucet: Circle's official

User action per agent:
1. Agent boot prints address (e.g. `agent[solver-02] = 0x…`)
2. User visits faucet, funds with ~0.01 Sepolia ETH (for gas)
3. User visits USDC faucet OR transfers USDC to the address
4. Agent polls balance; proceeds once both are above thresholds

## Backward compatibility

The old bearer-token flow (/auth/token client_credentials)
stays supported backend-side. A legacy `scripts/bootstrap.sh`
entry point can continue to target the old flow for regression
— we don't delete it. New agents default to wallet-login; old
agents can opt-in to the legacy path via a per-agent YAML flag
(`auth_mode: "legacy_bearer"` vs `auth_mode: "wallet"`).

## Risks flagged

1. **Nonce management on Base Sepolia**: parallel agents from
   the same mnemonic could collide on transaction nonces if
   they were all submitting txs simultaneously. For this
   project, agents mostly POST HTTP (backend signs/submits
   settlement txs); the only agent-originated tx is
   `Router.claim`, which happens post-settlement and is
   naturally serialized. Low risk unless agents start
   self-initiating txs.
2. **Mnemonic leak** = all agent wallets compromised. The
   mnemonic should live ONLY in `.env` (git-ignored);
   production operators should use a hardware wallet or KMS.
   Out of scope for staging.
3. **Rate limit on /auth/wallet** (loop 58, a-06): 30/hour
   per IP. A bootstrap script that sign-s in 6+ agents from
   one IP in a tight loop stays comfortably under — but if
   the limit tightens, bootstrap will need a backoff.
4. **Gas estimation for Router.claim**: unbenchmarked
   (07k.2 in backlog). First testnet run should log gas-used
   and we can pin a ceiling if needed.
