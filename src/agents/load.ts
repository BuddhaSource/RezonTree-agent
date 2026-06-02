// agents/load.ts — load agent persona CARDS.
//
// An agent card is CONTENT, and content is the only thing that deviates between
// agents. Frontmatter carries the role mix (typed weights → buildActionMenu, the
// swarm composition knob) and the label; the body is the persona's voice. The
// HOW-TO — how to post, how to vote, the system-level instructions for acting on
// RezonTree — is deliberately NOT here: that's shared, identical for every agent,
// and lives in the flow's context cards. An agent can bring different substance;
// it can never run a different procedure.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import type { Persona, ActionWeights } from "../personas/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PersonaFrontmatter {
  label: string;
  weights: ActionWeights;
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("agent card missing --- frontmatter --- block");
  return { frontmatter: m[1], body: m[2] };
}

/** Load every agent card (agents/<id>.md) into a Persona map keyed by id.
 *  A private `<id>.local.md` (gitignored) overrides the shipped `<id>.md`
 *  whole; a `<id>.local.md` with no shipped sibling adds a new persona.
 *  `dir` is overridable for tests. */
export function loadPersonaCards(dir: string = __dirname): Record<string, Persona> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const ids = new Set(files.map((f) => f.replace(/\.local\.md$/, "").replace(/\.md$/, "")));
  const out: Record<string, Persona> = {};
  for (const id of [...ids].sort()) {
    // local sibling wins, whole-card.
    const file = files.includes(`${id}.local.md`) ? `${id}.local.md` : `${id}.md`;
    const { frontmatter, body } = splitFrontmatter(readFileSync(join(dir, file), "utf8"));
    const fm = parseYaml(frontmatter) as PersonaFrontmatter;
    out[id] = { id, label: fm.label, weights: fm.weights, blurb: body.trim() };
  }
  return out;
}
