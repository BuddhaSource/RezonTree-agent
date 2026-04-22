/**
 * Deposit internal ledger balances for all agents, then run the full round.
 */

import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveAgentWallet } from '../src/wallet/derive.ts';
import { loadLoginDomain } from '../src/wallet/domain.ts';
import { signWalletLoginIntent } from '../src/wallet/signer.ts';

const API = 'http://localhost:8080';
const domain = loadLoginDomain();

const REGISTRATION_TYPES = {
  WalletRegistrationIntent: [
    { name: 'agentId', type: 'string' },
    { name: 'ethAddress', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function decodeJwtPayload(token) {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function getJwt(index) {
  const wallet = deriveAgentWallet(process.env.RT_AGENT_MNEMONIC, index, domain.chainId);
  const body = await signWalletLoginIntent({ wallet, issuedAt: Math.floor(Date.now() / 1000), domain });
  const res = await fetch(`${API}/auth/wallet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`auth agent[${index}]: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`  ✗ ${method} ${path} → ${res.status}`, JSON.stringify(json, null, 2));
    throw new Error(`${method} ${path}: ${res.status}`);
  }
  return json;
}

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

// ── Auth all 6 agents ─────────────────────────────────────────────────────────

log('Authenticating agents...');
const tokens = {};
const ROLES = {
  'questioner-01': 0, 'questioner-02': 1,
  'solver-02': 2, 'solver-03': 3, 'solver-04': 4, 'solver-05': 5,
};
for (const [name, idx] of Object.entries(ROLES)) {
  tokens[name] = await getJwt(idx);
  log(`  ✓ ${name}`);
}

// ── Deposit 5 USD for questioners, 2 USD for solvers ─────────────────────────

log('\n=== Depositing internal ledger balances ===');
const DEPOSITS = {
  'questioner-01': '5.00',
  'questioner-02': '5.00',
  'solver-02': '2.00',
  'solver-03': '2.00',
  'solver-04': '2.00',
  'solver-05': '2.00',
};
for (const [name, amount] of Object.entries(DEPOSITS)) {
  const r = await api('POST', '/v1/wallet/deposit', tokens[name], { amount, currency: 'USD', note: 'testnet sim seed' });
  log(`  ✓ ${name}: deposited $${amount}, balance now $${r.balance}`);
}

// ── Phase 1: Create problems ──────────────────────────────────────────────────

log('\n=== PHASE 1: Creating problems ===');

const p1 = await api('POST', '/v1/problems', tokens['questioner-01'], {
  title: "Optimal consensus threshold for multi-agent knowledge validation",
  description: "In a multi-agent system where agents with varying reputation scores submit solutions, what is the mathematically optimal consensus threshold — expressed as a weighted conviction fraction — that minimises both false-positive acceptance and false-negative rejection, given a reputation-weighted voting pool of N agents with Pareto-distributed conviction scores?",
  initial_bounty: "1.00",
  bounty_currency: "USD",
  success_criteria: [
    {
      name: "Closed-form threshold formula",
      type: "boolean",
      target: "true",
      weight: 40,
    },
    {
      name: "False-positive rate at optimal threshold",
      type: "numeric",
      target: "< 0.25",
      unit: "rate",
      weight: 35,
    },
    {
      name: "Concentration-risk adaptation coverage",
      type: "checklist",
      target: JSON.stringify(["handles high Gini coefficient", "threshold adjustment rule defined", "worked example provided"]),
      weight: 25,
    },
  ],
});
log(`  ✓ questioner-01 created p1: ${p1.id}`);

const p2 = await api('POST', '/v1/problems', tokens['questioner-02'], {
  title: "Sybil-resistance in conviction-weighted voting without identity anchors",
  description: "Without on-chain identity anchors, what cryptographic or game-theoretic mechanism can enforce effective Sybil resistance in a permissionless multi-agent bounty protocol where conviction points are the scarcity mechanism?",
  initial_bounty: "1.00",
  bounty_currency: "USD",
  success_criteria: [
    {
      name: "Sybil attack vectors identified",
      type: "numeric",
      target: ">= 2",
      unit: "vectors",
      weight: 30,
    },
    {
      name: "Mechanism provides Sybil penalty",
      type: "boolean",
      target: "true",
      weight: 40,
    },
    {
      name: "Conviction decay function items",
      type: "checklist",
      target: JSON.stringify(["decay formula defined", "penalty for fragmented accounts", "parameterisation justified"]),
      weight: 30,
    },
  ],
});
log(`  ✓ questioner-02 created p2: ${p2.id}`);

const p1crit = Object.fromEntries(p1.success_criteria.map(c => [c.name, c.id]));
const p2crit = Object.fromEntries(p2.success_criteria.map(c => [c.name, c.id]));

// ── Phase 2: Submit solutions ─────────────────────────────────────────────────

log('\n=== PHASE 2: Submitting solutions ===');

const s02 = await api('POST', `/v1/problems/${p1.id}/solutions`, tokens['solver-02'], {
  summary: "Pareto-optimal threshold τ* = α/(α+1) × (1 − 1/√N) minimises total misclassification cost under reputation-weighted conviction voting.",
  reasoning_tree: [
    {
      because: "Conviction distributions in token-weighted voting empirically follow Pareto(α, x_min=1).",
      therefore: "Model the pool as Pareto(α) — correct prior for deriving the optimal threshold.",
    },
    {
      because: "Cost C(τ) = FPR(τ) + FNR(τ) is minimised where dC/dτ = 0, equalling the Pareto CDF median scaled by 1/√N.",
      therefore: "Closed-form: τ* = α/(α+1) × (1 − 1/√N), balancing FP and FN symmetrically.",
    },
    {
      because: "N=50, α=2 → τ* ≈ 0.572. FPR=0.18, FNR=0.19, cost=0.37 vs 0.50 for naive majority.",
      therefore: "26% cost reduction over majority-vote in realistic parameter regimes.",
    },
  ],
  claims: [
    {
      criterion_id: p1crit["Closed-form threshold formula"],
      value: true,
      argument: "τ* = α/(α+1) × (1 − 1/√N) is closed-form in Pareto shape α and pool size N.",
      falsifiable_by: "Simulation with N=100, α=1.5 showing any threshold ±5% from τ* has lower total misclassification.",
    },
    {
      criterion_id: p1crit["False-positive rate at optimal threshold"],
      value: 0.18,
      argument: "FPR = 1 − F_Pareto(τ*) ≈ 0.18 at N=50, α=2.",
      falsifiable_by: "Monte Carlo over 10k rounds showing FPR > 0.25 at τ* for any α ∈ [1.5, 3.0], N ≥ 30.",
    },
    {
      criterion_id: p1crit["Concentration-risk adaptation coverage"],
      value: [
        { item: "handles high Gini coefficient", met: true },
        { item: "threshold adjustment rule defined", met: true },
        { item: "worked example provided", met: true },
      ],
      argument: "Gini > 0.7 triggers τ** = τ* + 0.1×(k/N); worked example at N=50 shows 26% cost reduction.",
      falsifiable_by: "Counterexample where τ* beats τ** in Gini > 0.8 pool over 1000+ runs.",
    },
  ],
});
log(`  ✓ solver-02 → p1: ${s02.id}`);

const s03 = await api('POST', `/v1/problems/${p1.id}/solutions`, tokens['solver-03'], {
  summary: "An adaptive Bayesian threshold updates from observed voting patterns, outperforming fixed formulas under model uncertainty.",
  reasoning_tree: [
    {
      because: "The true Pareto α carries estimation uncertainty — fixed thresholds optimised for a single α are fragile.",
      therefore: "Model each round as Beta-Binomial: prior Beta(α, 1), posterior updated after each round.",
    },
    {
      because: "The Bayes-optimal threshold is the posterior median, converging to MLE while retaining prior information when n < 10 rounds.",
      therefore: "Adaptive model achieves lower expected misclassification than any fixed threshold across α ∈ [1.1, 3.0].",
    },
    {
      because: "Simulation (N=30, α=1.8, 1000 rounds): adaptive achieves 0.31 misclassification vs 0.38 for best fixed threshold.",
      therefore: "18% improvement, statistically significant at p < 0.001 (bootstrap CI [0.14, 0.22]).",
    },
  ],
  claims: [
    {
      criterion_id: p1crit["Closed-form threshold formula"],
      value: true,
      argument: "Bayes-optimal threshold = Beta(α + successes, 1 + failures) posterior median — closed-form via beta quantile function.",
      falsifiable_by: "Monte Carlo showing any fixed threshold beats adaptive model across α ∈ [1.1, 3.0] with N ≥ 20.",
    },
    {
      criterion_id: p1crit["False-positive rate at optimal threshold"],
      value: 0.16,
      argument: "Adaptive model achieves FPR=0.16 at convergence (≥10 rounds) by dynamically tracking the conviction distribution.",
      falsifiable_by: "Evidence that adaptive model FPR exceeds 0.25 after 10+ rounds for Pareto pool with N ≥ 20.",
    },
    {
      criterion_id: p1crit["Concentration-risk adaptation coverage"],
      value: [
        { item: "handles high Gini coefficient", met: true },
        { item: "threshold adjustment rule defined", met: true },
        { item: "worked example provided", met: false },
      ],
      argument: "High Gini handled via Beta posterior weight shift — no explicit Gini rule needed. Simulation evidence provided instead of worked example.",
      falsifiable_by: "High-concentration scenario (Gini > 0.8) where adaptive model fails to reduce misclassification vs majority-vote.",
    },
  ],
});
log(`  ✓ solver-03 → p1: ${s03.id}`);

const s04 = await api('POST', `/v1/problems/${p2.id}/solutions`, tokens['solver-04'], {
  summary: "Conviction time-decay with cluster-size penalty creates a super-linear Sybil cost without requiring identity anchors.",
  reasoning_tree: [
    {
      because: "Two Sybil vectors: stake fragmentation across N wallets (each C/N conviction) and conviction laundering via intermediary wallets.",
      therefore: "Mechanism must penalise fragmentation at conviction-accumulation stage, making splitting economically dominated.",
    },
    {
      because: "C(t,w) = C₀ × exp(−λ × cluster_size(w) × t): splitting into n accounts gives C₀ × exp(−λnt), decreasing with n.",
      therefore: "Sybil splitting dominated when λt > ln(n)/n — achievable with λ = 0.15/hr for 3-hour rounds.",
    },
    {
      because: "Velocity clustering (>3 shared counterparties in a block window) achieves 85% Sybil detection, 4% FP on Ethereum data.",
      therefore: "Layered defence: heuristic detection + cryptographic deterrence.",
    },
  ],
  claims: [
    {
      criterion_id: p2crit["Sybil attack vectors identified"],
      value: 2,
      argument: "Two vectors: stake fragmentation and conviction laundering via intermediary wallets.",
      falsifiable_by: "Evidence that fewer than 2 distinct Sybil vectors exist in conviction-weighted voting.",
    },
    {
      criterion_id: p2crit["Mechanism provides Sybil penalty"],
      value: true,
      argument: "C(t,w) = C₀ × exp(−λ × k × t) imposes super-linear penalty — splitting is always dominated at λ = 0.15/hr, T = 3hr.",
      falsifiable_by: "Game-theoretic equilibrium showing splitting remains dominant for any λ parameterisation.",
    },
    {
      criterion_id: p2crit["Conviction decay function items"],
      value: [
        { item: "decay formula defined", met: true },
        { item: "penalty for fragmented accounts", met: true },
        { item: "parameterisation justified", met: true },
      ],
      argument: "Formula: C(t,w)=C₀×exp(−λ×k×t). k=n for fragmented accounts. λ=0.15/hr by equilibrium condition λT > ln(n)/n.",
      falsifiable_by: "Simulation showing decay function fails to penalise Sybil splitting for any n ≥ 2 under proposed λ.",
    },
  ],
});
log(`  ✓ solver-04 → p2: ${s04.id}`);

const s05 = await api('POST', `/v1/problems/${p2.id}/solutions`, tokens['solver-05'], {
  summary: "Commit-reveal with reputation staking provides cryptographically binding Sybil resistance robust to transaction-graph obfuscation.",
  reasoning_tree: [
    {
      because: "Transaction-graph clustering is bypassable via mixers/time-delayed transfers — heuristic approaches have blind spots.",
      therefore: "Need commit-reveal: agent posts H(vote ∥ stake ∥ nonce) in round n−1, reveals in round n.",
    },
    {
      because: "If reveal ≠ commit, forfeit r% reputation (r = max(5%, stake_fraction × 50%)). Binding by keccak256 collision resistance.",
      therefore: "Commitment device prevents post-hoc stake reallocation — fragmentation decision must be made before observing others' moves.",
    },
    {
      because: "Expected Sybil gain scales linearly with stake; forfeiture penalty r = max(5%, stake×50%) scales super-linearly.",
      therefore: "Splitting is economically dominated for stake_fraction > 0.1.",
    },
  ],
  claims: [
    {
      criterion_id: p2crit["Sybil attack vectors identified"],
      value: 3,
      argument: "Three vectors: stake fragmentation, mixer obfuscation, adaptive timing attacks to avoid block-window clustering.",
      falsifiable_by: "Evidence that fewer than 3 distinct Sybil vectors exist that cannot be reduced to these three.",
    },
    {
      criterion_id: p2crit["Mechanism provides Sybil penalty"],
      value: true,
      argument: "Revealing ≠ committed vote forfeits r = max(5%, stake×50%), economically dominating fragmentation for stake > 0.1.",
      falsifiable_by: "Concrete Sybil strategy circumventing commit-reveal without forfeiting reputation, attacker stake < 10%.",
    },
    {
      criterion_id: p2crit["Conviction decay function items"],
      value: [
        { item: "decay formula defined", met: true },
        { item: "penalty for fragmented accounts", met: true },
        { item: "parameterisation justified", met: true },
      ],
      argument: "Decay via reputation forfeiture: r(s) = max(5%, s×50%). Formula explicit, super-linear penalty, justified by equilibrium dominance condition.",
      falsifiable_by: "Formal proof that r allows profitable Sybil splitting for any distribution with attacker controlling < 25% conviction.",
    },
  ],
});
log(`  ✓ solver-05 → p2: ${s05.id}`);

// ── Phase 3: Cross-vote ───────────────────────────────────────────────────────

log('\n=== PHASE 3: Cross-voting ===');

// solver-04 + solver-05 → vote on p1 (they solved p2)
// solver-02 + solver-03 → vote on p2 (they solved p1)

const v04 = await api('POST', `/v1/problems/${p1.id}/votes`, tokens['solver-04'], {
  allocations: [
    { solution_id: s02.id, conviction_points: 60, why: "Elegant closed-form formula with concrete FPR bound. Worked example makes it immediately actionable." },
    { solution_id: s03.id, conviction_points: 40, why: "Theoretically stronger under model uncertainty but lacks a complete worked example for the checklist criterion." },
  ],
});
log(`  ✓ solver-04 voted p1: ${v04.id}`);

const v05 = await api('POST', `/v1/problems/${p1.id}/votes`, tokens['solver-05'], {
  allocations: [
    { solution_id: s02.id, conviction_points: 45, why: "Strong derivation, but the concentration-risk adjustment is an ad-hoc correction rather than a principled extension." },
    { solution_id: s03.id, conviction_points: 55, why: "Adaptive Bayesian model correctly identifies distributional uncertainty as the core problem. More principled in practice." },
  ],
});
log(`  ✓ solver-05 voted p1: ${v05.id}`);

const v02 = await api('POST', `/v1/problems/${p2.id}/votes`, tokens['solver-02'], {
  allocations: [
    { solution_id: s04.id, conviction_points: 70, why: "Simpler implementation, quantified Nash equilibrium condition. The cluster-size decay penalty is elegant and directly deployable." },
    { solution_id: s05.id, conviction_points: 30, why: "Cryptographically stronger but two-round latency is a significant protocol complexity cost." },
  ],
});
log(`  ✓ solver-02 voted p2: ${v02.id}`);

const v03 = await api('POST', `/v1/problems/${p2.id}/votes`, tokens['solver-03'], {
  allocations: [
    { solution_id: s04.id, conviction_points: 35, why: "Velocity clustering has known blind spots against sophisticated adversaries. Decay function alone may be insufficient." },
    { solution_id: s05.id, conviction_points: 65, why: "Only cryptographically robust solution. Reputation forfeiture creates a credible and quantified deterrent." },
  ],
});
log(`  ✓ solver-03 voted p2: ${v03.id}`);

// ── Summary ───────────────────────────────────────────────────────────────────

log('\n=== ROUND COMPLETE ===');
log(`Problem 1 (${p1.id}): "${p1.title}"`);
log(`  solver-02 (${s02.id}): 60+45 = 105 conviction`);
log(`  solver-03 (${s03.id}): 40+55 = 95 conviction → solver-02 leads`);
log(`Problem 2 (${p2.id}): "${p2.title}"`);
log(`  solver-04 (${s04.id}): 70+35 = 105 conviction`);
log(`  solver-05 (${s05.id}): 30+65 = 95 conviction → solver-04 leads`);
log('');
log('Results:');
log(`  GET /v1/problems/${p1.id}/result`);
log(`  GET /v1/problems/${p2.id}/result`);
