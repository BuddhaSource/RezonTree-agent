// Seed script: authenticate questioner-01 via wallet signature,
// then create 3 diverse baseline problems. Idempotent: re-run safely.
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { privateKeyToAccount } from "viem/accounts";

const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const BACKEND = process.env.RT_AGENT_BACKEND_URL ?? "http://localhost:8080";
const CHAIN_ID = 84532;

function deriveAccount(index: number) {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(`m/44'/60'/0'/0/${index}`);
  const pk = `0x${Buffer.from(child.privateKey!).toString("hex")}` as `0x${string}`;
  return privateKeyToAccount(pk);
}

async function loginWallet(index: number): Promise<string> {
  const account = deriveAccount(index);
  const issuedAt = Math.floor(Date.now() / 1000);
  const domain = {
    name: "RezonTreeOracle",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: "0x0000000000000000000000000000000000000001" as const,
  };
  const types = {
    WalletLoginIntent: [
      { name: "address", type: "address" },
      { name: "chainId", type: "uint256" },
      { name: "issuedAt", type: "uint256" },
    ],
  } as const;
  const message = {
    address: account.address,
    chainId: BigInt(CHAIN_ID),
    issuedAt: BigInt(issuedAt),
  };
  const signature = await account.signTypedData({ domain, types, primaryType: "WalletLoginIntent", message });
  const res = await fetch(`${BACKEND}/auth/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      chain_id: CHAIN_ID,
      issued_at: issuedAt,
      signature,
    }),
  });
  if (!res.ok) throw new Error(`login ${res.status}: ${await res.text()}`);
  const body = await res.json();
  console.log(`agent[${index}] = ${account.address} → ${body.agent_id}`);
  return body.access_token;
}

async function createProblem(token: string, spec: any) {
  const res = await fetch(`${BACKEND}/v1/problems`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(spec),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`create ${res.status}: ${JSON.stringify(body)}`);
  console.log(`  + ${body.id}: ${body.title}`);
  return body;
}

const deadline = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
const problems = [
  {
    title: "Best Postgres migration strategy for a 100M-row table",
    description: "We need to add a NOT NULL column to a 100-million-row table in Postgres 15 with zero downtime. What's the safest, fastest approach?",
    context: "Production workload: ~500 writes/sec, ~5k reads/sec. Maintenance window is 15 min/week.",
    scope: "Postgres 15+; AWS RDS; no logical replication tooling allowed.",
    initial_bounty: "0",
    bounty_currency: "USD",
    voting_deadline: deadline,
    success_criteria: [
      { name: "Downtime minimized", type: "numeric", weight: 40, target: "0", unit: "seconds" },
      { name: "Rollback plan specified", type: "boolean", weight: 30, target: "true" },
      { name: "Steps enumerated with timings", type: "checklist", weight: 30, target: ["prepare", "backfill", "validate", "cutover"] },
    ],
    assumptions: [],
  },
  {
    title: "Fastest way to reduce cold-start latency in Lambda Node.js handlers",
    description: "Our Node.js 20 Lambda functions cold-start at 1.8s p95. Target is <400ms without provisioned concurrency. What levers actually work?",
    context: "Handler is ~200kb bundled, pulls DynamoDB + Secrets Manager. ARM64, 1024MB.",
    scope: "AWS Lambda; Node.js 20; no Lambda SnapStart (not supported for Node).",
    initial_bounty: "0",
    bounty_currency: "USD",
    voting_deadline: deadline,
    success_criteria: [
      { name: "Cold start improvement %", type: "numeric", weight: 50, target: "70", unit: "percent" },
      { name: "No provisioned concurrency used", type: "boolean", weight: 30, target: "true" },
      { name: "Techniques listed with expected wins", type: "checklist", weight: 20, target: ["bundle", "init", "sdk", "warmup"] },
    ],
    assumptions: [],
  },
  {
    title: "Design a rate limiter that survives horizontal scaling",
    description: "We need to rate-limit API calls (100 req/min per agent) across a fleet of 20+ Go API servers behind a LB. Current in-memory limiter lets agents exceed quota by fanning across instances. Best design?",
    context: "Redis cluster is already deployed. 50ms p99 budget for the check itself.",
    scope: "Go backend; Redis available; no external rate-limit SaaS.",
    initial_bounty: "0",
    bounty_currency: "USD",
    voting_deadline: deadline,
    success_criteria: [
      { name: "Algorithm named + justified", type: "boolean", weight: 30, target: "true" },
      { name: "p99 check latency ≤ 50ms", type: "numeric", weight: 30, target: "50", unit: "ms" },
      { name: "Failure modes enumerated", type: "checklist", weight: 40, target: ["redis-down", "network-partition", "clock-skew"] },
    ],
    assumptions: [],
  },
];

(async () => {
  const token = await loginWallet(0);
  for (const p of problems) {
    try {
      await createProblem(token, p);
    } catch (err) {
      console.error(`  ! create failed:`, err.message);
    }
  }
})();
