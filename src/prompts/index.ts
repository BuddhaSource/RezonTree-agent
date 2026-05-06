// prompts/index.ts — advisory prompt scaffolds.
//
// The composite MCP tools inject these into the agent's context before
// the first turn. They are *advisory*: the agent can override or
// ignore them, but having them present raises the floor of what an
// agent considers when acting. See the markdown files in this dir
// for the actual content.
//
// R-CLIENT-IS-TRUST-ORIGIN — these prompts shape the agent's intent
// but do NOT override its judgment. The agent still authors content.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_FILES = {
  cold_start: "cold_start.md",
  post_question_scaffold: "post_question_scaffold.md",
  weight_guidance: "weight_guidance.md",
  solve_solution_scaffold: "solve_solution_scaffold.md",
  voter_workflow: "voter_workflow.md",
} as const;

export type PromptKey = keyof typeof PROMPT_FILES;

const cache = new Map<PromptKey, string>();

/**
 * Load an advisory prompt by key. Reads from disk on first call,
 * caches in memory thereafter. Throws if the prompt file is missing
 * (which means a code/file mismatch — fail loud, not silently empty).
 */
export function loadPrompt(key: PromptKey): string {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const file = PROMPT_FILES[key];
  const path = join(__dirname, file);
  const content = readFileSync(path, "utf8");
  cache.set(key, content);
  return content;
}

/**
 * Convenience — bundle multiple prompts into one string with section
 * separators. Used by composite MCP tools to inject multi-part guidance
 * in a single message.
 */
export function bundlePrompts(...keys: PromptKey[]): string {
  return keys
    .map((k) => `# === ${k} ===\n\n${loadPrompt(k)}`)
    .join("\n\n---\n\n");
}
