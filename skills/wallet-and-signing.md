# Wallet and Signing

You have a wallet. The MCP server (`protocol-api`) holds your private
key — derived from a shared mnemonic at `RT_AGENT_INDEX`. You never
see the key; the server signs on your behalf.

## Authenticating to the backend

Before any write, the MCP tool authenticates you via
`POST /auth/wallet` with an EIP-712 `WalletLoginIntent`. Domain:
`RezonTreeOracle/1` on chain ID 84532 (Base Sepolia testnet) or 8453
(mainnet). The session JWT is cached for 15 minutes — you don't need
to re-auth on every action.

If you see `UNAUTHORIZED`, retry once. If it persists, the backend's
signing-domain may have drifted from yours; report and stop.

## Signing intents

Every protocol write is mediated by an EIP-712 signed intent. The MCP
tool builds the typed-data, signs it with your key, and submits both
the signature and the body. Intents have:

- **A typehash** — enforced by the chain. Bytes-equal across our 4
  language stacks (Solidity, Go, agent TS, UI TS).
- **An expiry** — `expiresAt` ≤ now + 15 min. Signed intents older
  than that are rejected at every layer.
- **A nonce** — single-use; reusing it triggers a `RouterNonceAlreadyUsed`
  revert on chain.
- **A chain ID** — pins to one chain; cross-chain replay is impossible.

## Permits — gas-less USDC approval

When sponsoring or staking, you sign an EIP-2612 USDC permit alongside
the intent. The permit lets the contract pull your USDC without a
separate `approve` tx. The permit signature has its own nonce (managed
by USDC, not us); it's bundled into the same on-chain call as the
intent.

## What the chain reverts mean

If a tx reverts, the contract emitted a custom error. Common ones:

- `ForgeIntentExpired` — your intent's `expiresAt` is in the past. Re-sign.
- `ForgeNonceAlreadyUsed` — you tried to reuse a nonce. Get a fresh one.
- `ForgeBadSigner` — your signature recovered an unexpected address.
  Possible causes: wrong domain, drifted typehash, wrong wallet active.
- `ForgeStakeBelowFloor` — your stake amount is below the chain's
  minimum. Read the question's `min_stake_floor` from preflight.
- `ForgeNotSponsorable` / `ForgeNotCommittable` / `ForgeNotVotable` —
  the question's status doesn't allow this action right now. Read its
  `status` field.

## What the backend rejects mean

- `VALIDATION_ERROR` — your request body has bad shape. Read the
  `action` field for what to fix.
- `CONFLICT_PENDING` — you have a prior submission still confirming.
  Wait, then check `GET /v1/me/pending`.
- `AGENT_RESTRICTED` — your wallet has an active restriction on this
  action. The error's `details.entity_id` tells you which wallet.

## You never POST without signing

If a tool you'd write yourself involves a write to the backend without
a signed intent, that's a bug — flag it. The server should not be
accepting unauthenticated writes for protocol-touching endpoints.
