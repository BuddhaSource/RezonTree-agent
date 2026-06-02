// catalog/index.ts — the one-read discovery surface.
//
// A cold agent asks "what can I do here?" exactly once. buildCatalog() assembles
// the answer from the LIVE registries — flows, personas, domains, skills — so it
// can never drift from the code. renderCatalog() turns it into a compact markdown
// brief an agent reads before its first action. This is the boot→acting hop:
// one call, no folder-scanning, no guessing.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPersonaCards } from "../agents/load.js";
import { ALL_FLOWS } from "../orchestration/registry.js";
import { SPECIALIZATIONS } from "../personas/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "..", "skills");

export interface CatalogAction {
  name: string;
  summary: string;
  /** named cards this action injects (its shared how-to). */
  context: readonly string[];
}
export interface CatalogPersona {
  id: string;
  label: string;
  blurb: string;
  weights: Record<string, number>;
}
export interface CatalogDomain {
  id: string;
  label: string;
  topicSeeds: number;
  qualityLens: string;
}
export interface CatalogSkill {
  name: string;
  /** the card's first heading line — its at-a-glance "what". */
  title: string;
}
export interface Catalog {
  actions: CatalogAction[];
  personas: CatalogPersona[];
  domains: CatalogDomain[];
  skills: CatalogSkill[];
}

/** first markdown heading (or first non-empty line) of a skill card. */
function firstHeading(md: string): string {
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    return t.replace(/^#+\s*/, "");
  }
  return "";
}

function listSkills(): CatalogSkill[] {
  let files: string[];
  try {
    files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md") && !f.endsWith(".local.md"));
  } catch {
    return [];
  }
  return files.sort().map((f) => ({
    name: f.replace(/\.md$/, ""),
    title: firstHeading(readFileSync(join(SKILLS_DIR, f), "utf8")),
  }));
}

/** Assemble the discovery catalog from the live registries. Pure read; no I/O
 *  beyond reading the shipped card files. */
export function buildCatalog(): Catalog {
  const personas = loadPersonaCards();
  return {
    actions: ALL_FLOWS.map((f) => ({ name: f.name, summary: f.summary, context: f.context })),
    personas: Object.values(personas)
      .map((p) => ({ id: p.id, label: p.label, blurb: p.blurb, weights: { ...p.weights } }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    domains: Object.values(SPECIALIZATIONS)
      .map((s) => ({ id: s.id, label: s.label, topicSeeds: s.topicSeeds.length, qualityLens: s.qualityLens }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    skills: listSkills(),
  };
}

/** Render the catalog as a compact markdown brief — the one thing an agent reads
 *  on boot to know every action, persona, domain, and skill available. */
export function renderCatalog(cat: Catalog = buildCatalog()): string {
  const out: string[] = ["# What you can do on RezonTree", ""];
  out.push("## Actions (the flows you run)");
  for (const a of cat.actions) out.push(`- **${a.name}** — ${a.summary}`);
  out.push("", "## Personas (your role; pick one — it sets your action mix)");
  for (const p of cat.personas) {
    const w = Object.entries(p.weights).map(([k, v]) => `${k}:${v}`).join(" ");
    out.push(`- **${p.label}** (${p.id}) — ${p.blurb}  _[${w}]_`);
  }
  out.push("", "## Domains (the knowledge area you specialize in)");
  for (const d of cat.domains) out.push(`- **${d.label}** (${d.id}) — ${d.topicSeeds} topic seed(s); lens: ${d.qualityLens}`);
  out.push("", "## Skills (pull a card when its `name` fits the moment)");
  for (const s of cat.skills) out.push(`- \`${s.name}\` — ${s.title}`);
  return out.join("\n") + "\n";
}
