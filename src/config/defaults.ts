import type { AgentConfig } from "../types/index.js";

/**
 * Default values applied to agent configs when fields are omitted.
 */
export const AGENT_DEFAULTS: Partial<AgentConfig> = {
  max_turns: 50,
  max_budget_usd: 1.0,
  timeout_seconds: 300,
  output_format: "markdown",
};

/**
 * Merge agent config with defaults. Explicit values take precedence.
 */
export function applyAgentDefaults(config: AgentConfig): AgentConfig {
  return {
    ...AGENT_DEFAULTS,
    ...config,
    tools: config.tools ?? { builtin: ["Read", "Glob", "Grep"] },
  };
}
