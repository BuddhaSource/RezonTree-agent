// architecture.test.ts — the fences that LOCK the refactor so it can't rot.
//
// Three invariants, asserted structurally:
//   1. Flows are CODE, not cards — no .md in orchestration/flows.
//   2. Agents + skills are CONTENT — the dirs carry .md cards.
//   3. The money path is SEALED — forge/intents/wallet import nothing from the
//      decision/content layers above them. "Sealed" is a dependency direction,
//      not a folder: a private .local card can never reach the signing path
//      because the signing path never imports the card-driven layers.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/** All .ts files under a dir (recursive), excluding tests. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Import specifiers in a source file (`import … from "X"` and `import "X"`). */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2])!);
  return out;
}

// The money path (signs + broadcasts funds). Must depend only DOWNWARD.
const MONEY_PATH = ["forge", "intents", "wallet"];
// The decision/content layers that sit ABOVE it — importing any of these from
// the money path would invert the dependency and let card-driven config reach
// the signing path.
const UPPER_LAYERS = [
  "orchestration",
  "agents",
  "skills",
  "personas",
  "swarm",
  "bootstrap",
  "markets",
  "voting",
  "monitoring",
];

describe("architecture boundaries", () => {
  it("the money path imports nothing from the flow/content layers (sealed)", () => {
    const violations: string[] = [];
    for (const layer of MONEY_PATH) {
      for (const file of tsFiles(join(SRC, layer))) {
        for (const spec of importSpecifiers(file)) {
          const segs = spec.split("/");
          if (UPPER_LAYERS.some((u) => segs.includes(u))) {
            violations.push(`${file.replace(SRC, "src")} → ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("flows are code, not cards — no .md under orchestration/flows", () => {
    const flows = readdirSync(join(SRC, "orchestration", "flows"));
    expect(flows.filter((f) => f.endsWith(".md"))).toEqual([]);
  });

  it("agents + skills are content — the dirs carry .md cards", () => {
    expect(readdirSync(join(SRC, "agents")).some((f) => f.endsWith(".md"))).toBe(true);
    expect(readdirSync(join(SRC, "skills")).some((f) => f.endsWith(".md"))).toBe(true);
  });
});
