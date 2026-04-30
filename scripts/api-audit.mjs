/**
 * Full API audit script — hits every endpoint, records request + response.
 * Output: scripts/audit-results.json
 * Usage: node --experimental-vm-modules scripts/api-audit.mjs
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { deriveAgentWallet } from '../src/wallet/derive.ts';
import { loadLoginDomain } from '../src/wallet/domain.ts';
import { signWalletLoginIntent } from '../src/wallet/signer.ts';

const BASE = process.env.RT_AGENT_BACKEND_URL || 'http://localhost:8080';
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
const results = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function req(label, method, path, body, headers = {}) {
  const url = `${BASE}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);

  let status, json, error;
  try {
    const res = await fetch(url, opts);
    status = res.status;
    try { json = await res.json(); } catch { json = null; }
  } catch (e) {
    status = 0;
    error = e.message;
  }

  const entry = { label, method, path, status, request: body ?? null, response: json ?? null };
  if (error) entry.error = error;
  results.push(entry);
  const ok = status >= 200 && status < 300;
  console.log(`${ok ? '✓' : '✗'} [${status}] ${method} ${path}  (${label})`);
  return { status, body: json };
}

async function authedReq(label, method, path, body, token) {
  return req(label, method, path, body, { Authorization: `Bearer ${token}` });
}

// ── 1. Get agent JWT via wallet auth ─────────────────────────────────────────

console.log('\n=== AUTH ===');

const domain = loadLoginDomain();
const wallet0 = deriveAgentWallet(MNEMONIC, 0, domain.chainId);
const loginBody0 = await signWalletLoginIntent({ wallet: wallet0, issuedAt: Math.floor(Date.now() / 1000), domain });
const authRes = await req('wallet-auth-agent-0', 'POST', '/auth/wallet', loginBody0);
const agentJWT = authRes.body?.access_token;
const agentID = authRes.body?.agent_id;
if (!agentJWT) { console.error('FATAL: could not get agent JWT'); process.exit(1); }

// Derive a second agent for cross-agent tests
const wallet1 = deriveAgentWallet(MNEMONIC, 1, domain.chainId);
const loginBody1 = await signWalletLoginIntent({ wallet: wallet1, issuedAt: Math.floor(Date.now() / 1000), domain });
const authRes1 = await req('wallet-auth-agent-1', 'POST', '/auth/wallet', loginBody1);
const agent1JWT = authRes1.body?.access_token;
const agent1ID = authRes1.body?.agent_id;

// Test bad wallet auth
await req('wallet-auth-missing-fields', 'POST', '/auth/wallet', { evm_address: '0xBAD' });
await req('wallet-auth-no-body', 'POST', '/auth/wallet', {});

// Human user register + login
const email = `audit-${Date.now()}@test.local`;
await req('register-user', 'POST', '/auth/register', {
  email, password: 'Audit1234!', name: 'Audit User',
});
const loginRes = await req('login-user', 'POST', '/auth/login', { email, password: 'Audit1234!' });
const userJWT = loginRes.body?.access_token;
const refreshToken = loginRes.body?.refresh_token;

// Refresh token
if (refreshToken) {
  await req('refresh-token', 'POST', '/auth/refresh', { refresh_token: refreshToken });
}
await req('refresh-token-invalid', 'POST', '/auth/refresh', { refresh_token: 'bad_token' });

// client_credentials token (legacy)
await req('auth-token-missing-fields', 'POST', '/auth/token', {
  grant_type: 'client_credentials', client_id: 'bad', client_secret: 'bad',
});

// ── 2. Protocol & Discovery ───────────────────────────────────────────────────

console.log('\n=== PROTOCOL & DISCOVERY ===');
await authedReq('protocol-discovery', 'GET', '/v1/protocol', null, agentJWT);
await req('mcp-discovery', 'GET', '/v1/mcp', null);
await req('openapi-spec', 'GET', '/docs/openapi.json', null);
// Unauthenticated protocol (should 401)
await req('protocol-no-auth', 'GET', '/v1/protocol', null);

// ── 3. Agents ─────────────────────────────────────────────────────────────────

console.log('\n=== AGENTS ===');
const agentListRes = await authedReq('list-agents', 'GET', '/v1/agents', null, userJWT || agentJWT);
await authedReq('agent-profile', 'GET', `/v1/agents/${agentID}/profile`, null, agentJWT);
await authedReq('agent-reputation', 'GET', `/v1/agents/${agentID}/reputation`, null, agentJWT);
await authedReq('agent-reputation-history', 'GET', `/v1/agents/${agentID}/reputation/history`, null, agentJWT);
await authedReq('agent-profile-unknown', 'GET', '/v1/agents/agt_notexist/profile', null, agentJWT);

// ── 4. Problems ───────────────────────────────────────────────────────────────

console.log('\n=== PROBLEMS ===');

// List (public)
await req('list-problems-public', 'GET', '/v1/problems', null);
await req('list-problems-filter-open', 'GET', '/v1/problems?status=open', null);
await req('list-problems-filter-idle', 'GET', '/v1/problems?status=idle', null);
await req('list-problems-sort-bounty', 'GET', '/v1/problems?sort=initial_bounty', null);
await req('list-problems-sort-solutions', 'GET', '/v1/problems?sort=solution_count', null);
await req('list-problems-compact', 'GET', '/v1/problems?view=compact', null);
await req('list-problems-bad-sort', 'GET', '/v1/problems?sort=invalid', null);
await req('list-problems-search', 'GET', '/v1/problems?q=sybil', null);

// Search endpoint
await req('search-problems', 'GET', '/v1/problems/search?q=consensus', null);
await req('search-problems-no-q', 'GET', '/v1/problems/search', null);

// Create — valid
const createProblemBody = {
  title: 'API Audit Test Problem',
  description: 'A problem created during the automated API audit to verify endpoint contracts.',
  scope: 'API design and contract verification',
  initial_bounty: '0',
  bounty_currency: 'USD',
  success_criteria: [
    { name: 'All endpoints return expected shapes', type: 'boolean', target: 'true', weight: 100 },
  ],
};
const createRes = await authedReq('create-problem', 'POST', '/v1/problems', createProblemBody, agentJWT);
const problemID = createRes.body?.id;

// Create — validation errors
await authedReq('create-problem-missing-title', 'POST', '/v1/problems', {
  description: 'no title',
  success_criteria: [{ name: 'x', type: 'boolean', target: 'true', weight: 100 }],
}, agentJWT);

await authedReq('create-problem-missing-criteria', 'POST', '/v1/problems', {
  title: 'No criteria', description: 'missing criteria',
}, agentJWT);

await authedReq('create-problem-bad-bounty', 'POST', '/v1/problems', {
  title: 'Bad bounty', description: 'test',
  initial_bounty: 'not-a-number',
  success_criteria: [{ name: 'x', type: 'boolean', target: 'true', weight: 100 }],
}, agentJWT);

// Create with bounty
const createBountyRes = await authedReq('create-problem-with-bounty', 'POST', '/v1/problems', {
  ...createProblemBody,
  title: 'Audit Test Problem With Bounty',
  initial_bounty: '5.00',
  bounty_currency: 'USD',
}, agentJWT);
const problemWithBountyID = createBountyRes.body?.id;

// Get problem
if (problemID) {
  await req('get-problem', 'GET', `/v1/problems/${problemID}`, null);
  await req('get-problem-no-auth', 'GET', `/v1/problems/${problemID}`, null);
}
await req('get-problem-not-found', 'GET', '/v1/problems/prb_notexist000', null);

// ── 5. Credentials ────────────────────────────────────────────────────────────

console.log('\n=== CREDENTIALS ===');
if (userJWT && agentID) {
  const credRes = await authedReq('create-agent-credential', 'POST', `/v1/agents/${agentID}/credentials`, {
    label: 'audit-test-key',
  }, userJWT);
  const credID = credRes.body?.id;
  await authedReq('list-agent-credentials', 'GET', `/v1/agents/${agentID}/credentials`, null, userJWT);
  if (credID) {
    await authedReq('revoke-agent-credential', 'DELETE', `/v1/agents/${agentID}/credentials/${credID}`, null, userJWT);
  }
}

// ── 6. Solutions ──────────────────────────────────────────────────────────────

console.log('\n=== SOLUTIONS ===');

let solutionID;
if (problemID) {
  // Validate first
  const validateBody = {
    summary: 'Audit validation test — checking fee estimate.',
    reasoning_tree: [{ because: 'The API contract requires a reasoning tree', therefore: 'We include one here.' }],
    claims: [
      {
        criterion_id: createRes.body?.success_criteria?.[0]?.id ?? 'crt_test',
        value: true,
        argument: 'All endpoints were called and responses recorded.',
        falsifiable_by: 'Any endpoint returning an unexpected shape would disprove this.',
      },
    ],
  };
  await authedReq('validate-solution', 'POST', `/v1/problems/${problemID}/solutions/validate`, validateBody, agent1JWT || agentJWT);

  // Submit
  const submitRes = await authedReq('submit-solution', 'POST', `/v1/problems/${problemID}/solutions`, validateBody, agent1JWT || agentJWT);
  solutionID = submitRes.body?.id;

  // Validation errors
  await authedReq('submit-solution-missing-summary', 'POST', `/v1/problems/${problemID}/solutions`, {
    reasoning_tree: [{ because: 'test', therefore: 'test' }],
    claims: [],
  }, agentJWT);

  await authedReq('submit-solution-bad-reasoning', 'POST', `/v1/problems/${problemID}/solutions`, {
    summary: 'test',
    reasoning_tree: [{ step: 'wrong shape' }],
    claims: [{ criterion_id: 'crt_x', value: true, argument: 'x', falsifiable_by: 'y' }],
  }, agentJWT);

  // List solutions
  await req('list-solutions-full', 'GET', `/v1/problems/${problemID}/solutions`, null);
  await req('list-solutions-compact', 'GET', `/v1/problems/${problemID}/solutions?view=compact`, null);

  // Get solution
  if (solutionID) {
    await req('get-solution', 'GET', `/v1/problems/${problemID}/solutions/${solutionID}`, null);
  }
}

// ── 7. Votes ──────────────────────────────────────────────────────────────────

console.log('\n=== VOTES ===');

if (problemID && solutionID) {
  // Cast vote
  const voteRes = await authedReq('cast-vote', 'POST', `/v1/problems/${problemID}/votes`, {
    allocations: [
      { solution_id: solutionID, conviction_points: 100, why: 'Audit vote — testing contract.' },
    ],
  }, agentJWT);

  // Vote errors
  await authedReq('cast-vote-missing-allocations', 'POST', `/v1/problems/${problemID}/votes`, {}, agentJWT);
  await authedReq('cast-vote-missing-why', 'POST', `/v1/problems/${problemID}/votes`, {
    allocations: [{ solution_id: solutionID, conviction_points: 50 }],
  }, agentJWT);

  // Get votes
  await req('get-votes', 'GET', `/v1/problems/${problemID}/votes`, null);
}

// ── 8. Rounds ─────────────────────────────────────────────────────────────────

console.log('\n=== ROUNDS ===');

if (problemID) {
  const roundsRes = await req('list-rounds', 'GET', `/v1/problems/${problemID}/rounds`, null);
  const roundID = roundsRes.body?.data?.[0]?.id;
  if (roundID) {
    await req('get-round', 'GET', `/v1/problems/${problemID}/rounds/${roundID}`, null);
  }
}

// ── 9. Wallet ─────────────────────────────────────────────────────────────────

console.log('\n=== WALLET ===');
await authedReq('wallet-balance', 'GET', '/v1/wallet/balance', null, agentJWT);
await authedReq('wallet-balance-currency', 'GET', '/v1/wallet/balance?currency=USD', null, agentJWT);
await authedReq('wallet-history', 'GET', '/v1/wallet/history', null, agentJWT);

// Deposit
const depositRes = await authedReq('wallet-deposit', 'POST', '/v1/wallet/deposit', {
  amount: '10.00', currency: 'USD', source: 'audit-test',
}, agentJWT);

// Deposit errors
await authedReq('wallet-deposit-negative', 'POST', '/v1/wallet/deposit', {
  amount: '-5.00', currency: 'USD',
}, agentJWT);
await authedReq('wallet-deposit-missing-amount', 'POST', '/v1/wallet/deposit', {
  currency: 'USD',
}, agentJWT);

// ── 10. Fund problem ──────────────────────────────────────────────────────────

console.log('\n=== FUND / CONTRIBUTIONS ===');
if (problemID) {
  await authedReq('fund-problem', 'POST', `/v1/problems/${problemID}/fund`, {
    amount: '1.00', currency: 'USD',
  }, agentJWT);

  await authedReq('fund-problem-missing-amount', 'POST', `/v1/problems/${problemID}/fund`, {
    currency: 'USD',
  }, agentJWT);
}

// ── 11. Resolution ────────────────────────────────────────────────────────────

console.log('\n=== RESOLUTION ===');
if (problemID) {
  // Get result before closing (should fail or return empty)
  await req('get-result-open', 'GET', `/v1/problems/${problemID}/result`, null);

  // Close: cancel (so we don't mess up a real problem)
  await authedReq('close-problem-cancel', 'POST', `/v1/problems/${problemID}/close`, {
    action: 'cancel', reason: 'API audit — cleaning up test problem.',
  }, agentJWT);

  // Try to close already-closed
  await authedReq('close-problem-already-closed', 'POST', `/v1/problems/${problemID}/close`, {
    action: 'cancel',
  }, agentJWT);

  // Get result after close
  await req('get-result-cancelled', 'GET', `/v1/problems/${problemID}/result`, null);
}

// ── 12. Restrictions ──────────────────────────────────────────────────────────

console.log('\n=== RESTRICTIONS ===');
if (userJWT && agentID) {
  const restrictRes = await authedReq('create-restriction', 'POST', '/v1/restrictions', {
    entity_id: agentID,
    entity_type: 'agent',
    action: 'solution.submit',
    reason: 'API audit test restriction.',
  }, userJWT);
  const restrictID = restrictRes.body?.id;
  await authedReq('list-restrictions', 'GET', `/v1/restrictions?entity_id=${agentID}`, null, userJWT);
  if (restrictID) {
    await authedReq('delete-restriction', 'DELETE', `/v1/restrictions/${restrictID}`, null, userJWT);
  }
}

// ── 13. Error format checks ───────────────────────────────────────────────────

console.log('\n=== ERROR FORMAT CHECKS ===');
// 401 on protected endpoint
await req('unauth-protected', 'GET', '/v1/wallet/balance', null);
// 404
await req('not-found', 'GET', '/v1/problems/prb_doesnotexist123', null);
// Method not allowed
await req('method-not-allowed', 'DELETE', '/v1/problems', null, { Authorization: `Bearer ${agentJWT}` });

// ── Write results ─────────────────────────────────────────────────────────────

const outPath = new URL('./audit-results.json', import.meta.url).pathname;
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\n✓ Wrote ${results.length} entries → ${outPath}`);

const passed = results.filter(r => r.status >= 200 && r.status < 300).length;
const failed = results.filter(r => r.status === 0).length;
console.log(`  ${passed}/${results.length} successful  |  ${failed} connection errors`);
