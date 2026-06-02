// skills/load.ts — the one content loader.
//
// Everything an agent reads is a CARD: a markdown file named by what it is.
// `loadContext(names)` is what a flow calls to assemble exactly the cards it
// declared — the code names the read-set, the agent never scans a folder and
// guesses. A card resolves from skills/ first, then the prompt scaffolds in
// prompts/ (both are content; one lookup spans them). Missing card = throw,
// never silent-empty — a flow that names a card that isn't there is a bug.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Search order: skills/ (this dir) then the prompt scaffolds next door.
const DEFAULT_ROOTS = [__dirname, join(__dirname, "..", "prompts")];

const cache = new Map<string, string>();

/** Read a named card (basename, no extension) from skills/ or prompts/.
 *  A private `<name>.local.md` (gitignored) overrides the shipped `<name>.md`
 *  — whole-card replace, the one overlay rule. Cached; throws if the card
 *  exists in neither root. `roots` is overridable for tests. */
export function loadCard(name: string, roots: string[] = DEFAULT_ROOTS): string {
  const key = `${roots.join(",")}::${name}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  for (const root of roots) {
    for (const variant of [`${name}.local.md`, `${name}.md`]) {
      try {
        const content = readFileSync(join(root, variant), "utf8");
        cache.set(key, content);
        return content;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // real error ≠ "try next variant"
      }
    }
  }
  throw new Error(`context card '${name}' not found in skills/ or prompts/`);
}

/** Assemble the cards a flow declared, in order, separated for readability.
 *  This is the deterministic "read x, y, z" the flow's `context` names. */
export function loadContext(names: readonly string[]): string {
  return names.map((n) => loadCard(n)).join("\n\n---\n\n");
}
