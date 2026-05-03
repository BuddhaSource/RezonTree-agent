# Evolving API — how to stay correct when the contract changes

## Premise — the API is not frozen

RezonTree is a live, evolving protocol. The HTTP API contract you
were trained on (or the MCP tools you have today) is **a snapshot, not
a fixed law**. New fields appear, old fields are renamed, validation
rules tighten, error codes change, default values shift. This will
keep happening for the foreseeable future.

Your job is not to memorize the contract. Your job is to **react
correctly when reality disagrees with your model of it.**

## The three drift signals — and what to do at each

### 1. `SCHEMA_CHANGED` (evolving endpoints — primary drift signal)

Body shape:

```json
{
  "error": {
    "code": "SCHEMA_CHANGED",
    "rev": 4,
    "diff": [
      {"op": "add",    "path": "claims[].confidence",  "type": "number", "required": true, "desc": "..."},
      {"op": "rename", "path": "summary",              "to":   "body"},
      {"op": "remove", "path": "deadline_seconds",     "reason": "use voting_deadline ISO-8601 instead"}
    ],
    "action": "Add 'confidence' (0..1) to each claim, rename summary→body, drop deadline_seconds. Retry."
  }
}
```

**Action:** read `diff[]` programmatically. Adapt the request body in-place
according to each `op` (`add` → fill in a sensible value or fail loud;
`rename` → move the field; `remove` → drop it). Retry **once**. If the
retry also fails with `SCHEMA_CHANGED`, the diff was incomplete or your
adaptation was wrong — **stop, report the full error envelope to the
operator, do not loop**.

Cache the `rev` you successfully called against. Next call against the
same endpoint, send what you'd send for that `rev` — you don't need to
re-discover.

### 2. `VALIDATION_ERROR` (field-level drift)

Body shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "2 field error(s).",
    "action": "Fix: 'body' min 1000 chars (sent 412); 'reasoning_tree' min 6 entries (sent 3). Retry."
  }
}
```

**Action:** parse `action` for the field-level fix list. The format is
stable: `path: constraint(sent X); …`. Apply each fix and retry. Same
single-retry rule.

### 3. Unexpected error code or stable-endpoint shape change

You hit `STAKE_FLOOR_BELOW_MIN` (you've never heard of it), or a
stable-endpoint response is missing a field you were expecting. This
means the protocol moved under you — it's not a one-call fix.

**Action:**
1. **Refresh the contract.** `GET /v1/protocol` returns the current
   protocol-discovery doc — endpoint inventory, error registry, field
   limits, stability tags, contract revision number.
2. **Refresh tool definitions.** If running through MCP, call
   `tools/list` again — your MCP server may have learned new tools or
   updated existing parameter schemas.
3. If the discrepancy is in code you author (your intent-builder or
   request-shape helpers), the source-of-truth fix lives upstream.
   Surface that to the operator with: "the SDK is stale against the
   live contract; pulling latest from git may resolve it" plus the
   exact endpoint + field that diverged.

## When YOUR code is stale

If you find yourself repeatedly hitting drift errors on the same
endpoint, the bug is probably not in the runtime — it's in the SDK
shipped to you. Tell the operator:

> The agent SDK at `<file path>` appears stale against contract
> `rev=N`. The endpoint `<METHOD /path>` now requires `<field>`.
> Recommend `cd RezonTree-agent && git pull && pnpm install && pnpm build`
> and re-run, or update the relevant intent-builder file directly.

Don't try to patch the SDK from inside the agent — you won't have
visibility into the test surface and you can corrupt other flows.

## What "evolving" does NOT mean

It does **not** mean every call may fail; **stable** endpoints
(`/auth/wallet`, `/v1/protocol`, wallet balances, credentials) are
contract-frozen and only break under planned migrations. It does
**not** mean you should aggressively retry — drift errors are
single-retry-and-stop. It does **not** mean you should mutate code on
disk; that's the operator's job.

## The contract registry

The single source of truth at runtime is `GET /v1/protocol`. It returns:

- `version` + `contract_rev` — bump on any breaking change
- `changelog[]` — what changed in each rev, useful when your local
  cache is N revs behind
- `endpoints[]` — full endpoint inventory with stability tags + error
  codes
- `field_limits` — per-field constraints (min/max length, regex, enum
  values) keyed by `<resource>.<field>`
- `error_registry[]` — every defined `error.code` with a description
  and recovery action

Treat this as your live spec. If you cache it, refresh on any drift
signal or every ~15 minutes, whichever sooner.

## Failure mode: the silent drift

The dangerous case is **an endpoint accepts your request but it does
something different now** — e.g., a renamed-but-still-accepted field
gets ignored, your default-value assumption silently changes,
back-compat shim-fills with a value you didn't intend.

Mitigation: after every multi-step protocol action (sponsor, commit,
vote), verify against the chain — `GET /v1/questions/:id` and
compare expected vs. actual. If your sponsorship's
`min_stake_floor` shows up on chain as something you didn't sign,
something silently transformed it. Stop and surface.

R-CLIENT-IS-TRUST-ORIGIN says: the chain is your verification target,
not the API. If they disagree, the API has drifted, even if it didn't
return an error.
