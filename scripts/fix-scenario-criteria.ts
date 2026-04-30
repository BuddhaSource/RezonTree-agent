// fix-scenario-criteria.ts — coerce sub-agent-generated criteria
// shapes into what the backend validator accepts.
//
// Bugs in the generated YAML:
//   - boolean targets are prose; backend wants exactly "true" or "false"
//   - type "metric" is rejected; backend whitelist is "numeric" | "boolean" | "checklist"
//   - checklist targets are prose strings; backend wants JSON-array strings
//
// Strategy: cheapest defensible normalisation. Rewrite every criterion
// to type=boolean, target="true". The protocol uses these only as
// weighted-judge inputs at settlement; the on-chain hash doesn't care.
// Long prose targets become a `desc` so the content survives for
// readers + future re-typing.

import * as fs from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const inFile = process.argv[2] ?? "/tmp/agent-battle/scenarios-50-with-roles.yaml";
const outFile = process.argv[3] ?? "/tmp/agent-battle/scenarios-50-with-roles-fixed.yaml";

type Criterion = {
  name: string;
  type: string;
  target?: unknown;
  weight: number;
  desc?: string;
};
type Scenario = { id: string; success_criteria?: Criterion[] };

const doc = parseYaml(fs.readFileSync(inFile, "utf-8")) as Record<string, unknown>;
const scenarios = (doc.scenarios as Scenario[]) ?? [];

let touched = 0;
for (const s of scenarios) {
  if (!s.success_criteria) continue;
  for (const c of s.success_criteria) {
    const originalTarget = typeof c.target === "string" ? c.target : JSON.stringify(c.target ?? "");
    const isPlainTrueFalse = originalTarget === "true" || originalTarget === "false";
    // Whitelist approach: keep only `type: boolean, target: "true"|"false"`
    // untouched. Anything else gets coerced — handles boolean-with-prose,
    // numeric (unit-required), metric (invalid type), checklist (target
    // shape rejected), enum (invalid type), and any other sub-agent
    // creativity that violates the validator.
    const needsRewrite = c.type !== "boolean" || !isPlainTrueFalse;
    if (needsRewrite) {
      // preserve original target as desc so the content survives
      if (originalTarget && originalTarget.length > 0 && !c.desc) {
        c.desc = originalTarget.length > 480 ? originalTarget.slice(0, 480) + "…" : originalTarget;
      }
      c.type = "boolean";
      c.target = "true";
      touched++;
    }
  }
}

fs.writeFileSync(outFile, stringifyYaml(doc, { lineWidth: 0 }));
console.log(`fixed ${touched} criteria across ${scenarios.length} scenarios → ${outFile}`);
