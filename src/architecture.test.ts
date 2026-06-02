// architecture.test.ts — the fences that LOCK the refactor so it can't rot.
//
// Three invariants, asserted structurally:
//   1. Flows are CODE, not cards — no .md anywhere under orchestration.
//   2. Agents + skills are CONTENT — the dirs carry .md cards and nothing but
//      their loader in .ts (no stray logic / flows).
//   3. The money path is SEALED — forge/intents/wallet import only DOWNWARD
//      (an allowlist of card-free layers). "Sealed" is a dependency direction,
//      not a folder: a private .local card can never reach the signing path
//      because the signing path never imports the card-driven layers. The
//      allowlist is safe-by-default — a new card-driven layer is forbidden
//      unless explicitly allowed, so the fence can't silently miss one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Files under a dir (recursive) with the given extension, excluding tests. */
function filesWithExt(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...filesWithExt(p, ext));
    else if (entry.endsWith(ext) && !entry.endsWith(".test.ts")) out.push(p);
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

// The money path (signs + broadcasts funds). It may import only DOWNWARD: its
// own siblings + the card-free infra below it. Everything else — every
// decision/content layer, AND card-driven layers like methodology/prompts — is
// forbidden by omission. Add to this set only after confirming the target is
// genuinely card-free.
const MONEY_PATH = ["forge", "intents", "wallet"];
const ALLOWED_TARGETS = new Set(["forge", "intents", "wallet", "testnet", "utils", "format", "core"]);

describe("architecture boundaries", () => {
  it("the money path imports only downward — sealed (allowlist, safe-by-default)", () => {
    const violations: string[] = [];
    for (const layer of MONEY_PATH) {
      for (const file of filesWithExt(join(SRC, layer), ".ts")) {
        for (const spec of importSpecifiers(file)) {
          if (!spec.startsWith(".")) continue; // external pkg / node builtin — fine
          const rel = relative(SRC, resolve(dirname(file), spec));
          if (rel.startsWith("..")) continue; // resolves outside src — not our concern
          const target = rel.split(/[\\/]/)[0];
          if (!ALLOWED_TARGETS.has(target)) {
            violations.push(`${relative(SRC, file)} → ${spec} (layer: ${target})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("flows are code, not cards — no .md anywhere under orchestration", () => {
    expect(filesWithExt(join(SRC, "orchestration"), ".md").map((f) => relative(SRC, f))).toEqual([]);
  });

  it("agents + skills are content — cards present, and the only .ts is the loader", () => {
    for (const d of ["agents", "skills"]) {
      const entries = readdirSync(join(SRC, d));
      expect(entries.some((f) => f.endsWith(".md"))).toBe(true); // cards present
      const strayTs = entries.filter((f) => f.endsWith(".ts") && !/^load(\.test)?\.ts$/.test(f));
      expect(strayTs).toEqual([]); // no logic/flows smuggled into a content dir
    }
  });
});
