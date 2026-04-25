# Agent SDK scripts — index

Each script targets a specific scenario against the live Router v2.3
deployment on Base Sepolia. They compose a backend + the Router; the
backend is reached via `RT_BACKEND_URL` (default
`http://localhost:8080`).

## End-to-end flows

| Script | Scope | Wallets | Slash? | Use when |
|---|---|---|---|---|
| **`broadcast-fund.ts`** | Fund-only — single-wallet, exercises the `fund` path | 1 | No | Smoke-test the fund endpoint after a backend change |
| **`broadcast-full.ts`** | Single round happy path: fund → commit → vote → settle → claim → bond refunds | 3 (a/b/c + fee) | No | Default demo. **`continuous-loop.sh` calls this in a loop.** |
| **`broadcast-multi-party.ts`** | Single round with one losing solver + one wrong voter; exercises slash + bond-claim revert assertions | 5 (a/b/c/d + fee) | Yes (1 commit + 1 vote bond) | Verify slash + RouterBondAlreadyClaimed reverts |
| **`broadcast-multi-round.ts`** | 3 problems, 4 agents rotating roles; ledger-style accounting | 4 + fee | Yes (1 per round) | Stress-test rotating-role accounting end-to-end |

## Operational

| Script | Purpose |
|---|---|
| **`continuous-loop.sh`** | Drives `broadcast-full.ts` indefinitely with a w1→w0 rebate per round so the demo never starves the funder |
| **`audit-balances.ts`** | One-shot snapshot of named wallets + Router balance |
| **`run-round.sh`** | Wrapper that sources `.env`, sets defaults, calls a chosen broadcast script |
| **`sim-cycle.sh`** | Shell version of a single round (legacy convenience wrapper) |
| **`settle-claim.ts`** | Manual settle + claim against an existing problem (operator path) |

## Bootstrap / one-shots

| Script | Purpose |
|---|---|
| **`seed.ts`** | Initialize a fresh test environment: token registry, restrictions |
| **`gen-mnemonic.ts`** | Generate a fresh BIP-44 mnemonic for testnet operator setup |
| **`simulate-flow.ts`** | Older single-flow simulation (kept for reference; `broadcast-full.ts` is the canonical path) |
| **`api-audit.mjs`** | Audit backend HTTP surface from outside |

## Scripts that have been deleted

These rejected-prototype probes were removed in the v2.3 audit pass:
- `probe-router-v24.ts` — 0xSplits-backed Router prototype (rejected)
- `probe-0xsplits.ts` — 0xSplits feasibility probe (rejected)
- `deposit-and-round.mjs` — pre-Phase-H internal-ledger flow
- `probe-auth.mjs` — pre-Phase-H email/password auth probe

## Common environment

All scripts source `.env` for:
- `RT_AGENT_MNEMONIC` — operator BIP-44 mnemonic (wallets 0..N derived)
- `RT_ROUTER_ADDRESS` — defaults to the live v2.3 deploy
  (`0x946d489e8a8ae877f1f063d3ed03571e2dc86e5e` on Base Sepolia)
- `RT_RPC_URL` — defaults to `https://sepolia.base.org`
- `RT_BACKEND_URL` — defaults to `http://localhost:8080`
- `RT_PLATFORM_FEE_BPS` — settlement fee in basis points (default 1000 = 10%)
