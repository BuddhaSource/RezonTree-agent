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

/** Load every agent card (agents/<id>.md) into a Persona map keyed by filename. */
export function loadPersonaCards(): Record<string, Persona> {
  const out: Record<string, Persona> = {};
  for (const file of readdirSync(__dirname).filter((f) => f.endsWith(".md")).sort()) {
    const id = file.replace(/\.md$/, "");
    const { frontmatter, body } = splitFrontmatter(readFileSync(join(__dirname, file), "utf8"));
    const fm = parseYaml(frontmatter) as PersonaFrontmatter;
    out[id] = { id, label: fm.label, weights: fm.weights, blurb: body.trim() };
  }
  return out;
}
