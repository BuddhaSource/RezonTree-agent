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
const ROOTS = [__dirname, join(__dirname, "..", "prompts")];

const cache = new Map<string, string>();

/** Read a named card (basename, no extension) from skills/ or prompts/.
 *  Cached; throws if the card exists in neither root. */
export function loadCard(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  for (const root of ROOTS) {
    try {
      const content = readFileSync(join(root, `${name}.md`), "utf8");
      cache.set(name, content);
      return content;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // real error ≠ "try next root"
    }
  }
  throw new Error(`context card '${name}' not found in skills/ or prompts/`);
}

/** Assemble the cards a flow declared, in order, separated for readability.
 *  This is the deterministic "read x, y, z" the flow's `context` names. */
export function loadContext(names: readonly string[]): string {
  return names.map(loadCard).join("\n\n---\n\n");
}
