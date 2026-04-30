# Agent SDK scripts — index

Each script targets a specific scenario against the live RezonForge
v2.5 deployment on Base Sepolia. They compose a backend + the
Router; the backend is reached via `RT_BACKEND_URL` (default
`http://localhost:8080`).

## Battle harness — Phase D demo

| Script | Purpose |
|---|---|
| **`run-battle.ts`** | Walks every scenario in `battle-scenarios.yaml` through the full v2.5 lifecycle (sponsor → cosponsor → commit → vote → settle → claim → bond refund) and runs the attack lane. Writes `battle-report.json` with finance reconciliation + sybil findings + attack-defense outcomes. |
| **`battle-scenarios.yaml`** | 24 lifecycle scenarios across technical / governance / policy / design / economic domains, plus 5 sybil scenarios + 6 attack vectors. |
| **`finance-audit.ts`** | Module that snapshots wallet + Router USDC balances, reconciles per-problem inflows vs distributions, and computes chain-total drift. Imported by `run-battle.ts`; can also be `import`ed from one-off audit scripts. |

### Funding requirements (READ ME BEFORE RUNNING)

The runner derives 14 wallets via BIP-44 from `RT_AGENT_MNEMONIC`
(indices 0–13). Each wallet that participates in a scenario needs
both ETH (gas) and USDC (sponsorships, fees, bonds).

Recommended per-wallet starting balances on Base Sepolia:

| Role indices | ETH (gas) | USDC | Why |
|---|---|---|---|
| 0 (operator/oracle/fee) | 0.05 | 5 | publishes settlement for every scenario |
| 1 (alice — primary sponsor) | 0.02 | 60 | sponsors most lifecycle scenarios at 1 USDC each |
| 2-3 (bob, carol — primary solver/voter) | 0.02 each | 8 | bonds + fees across all scenarios |
| 4-8 (secondary solvers/voters/cosponsor/honest) | 0.01 each | 5 | participate in subsets |
| 9-11 (ivan family — sybil operator group) | 0.01 each | 5 | sybil scenarios |
| 12-13 (mallory family — attackers) | 0.01 each | 3 | attack lane |

Funding faucets:
- Base Sepolia ETH: <https://www.alchemy.com/faucets/base-sepolia>
- Base Sepolia USDC: Circle's testnet faucet, or transfer from any
  pre-funded wallet at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

Bootstrap helper: `pnpm testnet:bootstrap` derives the addresses,
prints them, and waits for funding before continuing. Re-run it
after expanding the wallet pool — it's idempotent.

### Running a battle

```bash
# 1. Source env (mnemonic + router address must be set)
source .env

# 2. Verify funding
pnpm testnet:bootstrap

# 3. Run the battle (writes scripts/battle-report.json)
npx tsx scripts/run-battle.ts

# 4. Inspect the report
jq '.perProblem | map({scenarioId, conserves, drift})' scripts/battle-report.json
jq '.attackVectors' scripts/battle-report.json
```

Override the scenario file:

```bash
RT_BATTLE_FILE=scripts/my-scenarios.yaml npx tsx scripts/run-battle.ts
```

The report is written even on partial failure — every crashed
scenario shows up in `perProblem` with `notes`.

## Operational

| Script | Purpose |
|---|---|
| **`continuous-loop.sh`** | Drives `run-battle.ts` indefinitely with a w1→w0 rebate per round so the demo never starves the funder |
| **`audit-balances.ts`** | One-shot snapshot of named wallets + Router balance |
| **`run-round.sh`** | Wrapper that sources `.env`, sets defaults, runs a single agent-CLI round (Phase B path) |
| **`sim-cycle.sh`** | Shell version of a single round (legacy convenience wrapper) |
| **`settle-claim.ts`** | Manual settle + claim against an existing problem (operator path; takes `RT_QID`) |

## Bootstrap / one-shots

| Script | Purpose |
|---|---|
| **`seed.ts`** | Initialize a fresh test environment: token registry, restrictions |
| **`gen-mnemonic.ts`** | Generate a fresh BIP-44 mnemonic for testnet operator setup |
| **`api-audit.mjs`** | Audit backend HTTP surface from outside |

## Scripts that have been deleted

- `broadcast-full.ts` / `broadcast-fund.ts` / `broadcast-multi-party.ts`
  / `broadcast-multi-round.ts` / `broadcast-swarm.ts` /
  `broadcast-swarm-full.ts` / `simulate-flow.ts` — pre-v2.5 prototypes
  that imported `fund-intent` (renamed to `sponsor-intent` /
  `cosponsor-intent` in v2.5). Their lifecycle coverage now lives in
  `run-battle.ts` driven by `battle-scenarios.yaml`.
- `probe-router-v24.ts` / `probe-0xsplits.ts` — rejected feasibility
  probes (v2.3 audit pass).
- `deposit-and-round.mjs` / `probe-auth.mjs` — pre-Phase-H email/
  password / internal-ledger flows.

## Common environment

All scripts source `.env` for:
- `RT_AGENT_MNEMONIC` — operator BIP-44 mnemonic (wallets 0..N derived)
- `RT_FORGE_ADDRESS` — RezonForge v2.5 deploy address on Base Sepolia
- `RT_RPC_URL` — defaults to `https://sepolia.base.org`
- `RT_BACKEND_URL` — defaults to `http://localhost:8080`
- `RT_PLATFORM_FEE_BPS` — settlement fee in basis points (default 1000 = 10%)
- `RT_BATTLE_FILE` — scenario YAML path (run-battle.ts)
- `RT_BATTLE_REPORT` — output JSON path (run-battle.ts)
