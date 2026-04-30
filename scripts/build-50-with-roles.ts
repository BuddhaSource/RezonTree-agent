// build-50-with-roles.ts — augment scenarios-50.yaml content with the
// q00 minimum-wallet role pattern (alice sponsor, bob solver, operator
// voter), so the existing run-battle.ts harness can drive them.
//
// Output: /tmp/agent-battle/scenarios-50-with-roles.yaml — drop-in
// replacement for battle-scenarios.yaml, extending the file's existing
// wallet_pool + auditor + attack_scenarios sections so all the harness
// invariants stay valid.

import * as fs from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const baseFile = "/Volumes/Data/projects/rezontree/RezonTree-agent/scripts/battle-scenarios.yaml";
const contentFile = "/tmp/agent-battle/scenarios-50.yaml";
const outFile = "/tmp/agent-battle/scenarios-50-with-roles.yaml";

const base = parseYaml(fs.readFileSync(baseFile, "utf-8")) as Record<string, unknown>;
const content = parseYaml(fs.readFileSync(contentFile, "utf-8")) as { scenarios: unknown[] };

// Replace the scenarios array. Keep wallet_pool, attack_scenarios,
// sybil_scenarios, audit, etc. Then add role fields to each generated
// scenario so the harness's BattleConfig type validates.
const augmented = (content.scenarios as Array<Record<string, unknown>>).map((s) => ({
  ...s,
  sponsor: "alice",
  cosponsors: [],
  solvers: ["bob"],
  voters: ["operator"],
  intended_winner_profile: "bob",
  expected_solver_count: 1,
  expected_voter_count: 1,
  expected_outcome: "success",
}));

base.scenarios = augmented;
// Disable non-q00 attacks + sybils — they reference wallets we don't have funded.
base.attack_scenarios = [];
base.sybil_scenarios = [];

fs.writeFileSync(outFile, stringifyYaml(base, { lineWidth: 0 }));
console.log(`wrote ${augmented.length} scenarios → ${outFile}`);
