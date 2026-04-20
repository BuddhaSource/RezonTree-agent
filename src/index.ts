/**
 * AgentKit — Configurable multi-agent orchestrator framework.
 *
 * @example
 * ```typescript
 * import { loadFrameworkConfig, Executor } from "agentkit";
 *
 * const config = loadFrameworkConfig("./config");
 * const executor = new Executor({ config });
 *
 * const result = await executor.runAgent("researcher", "Analyze this problem...");
 * console.log(result.output);
 * ```
 */

// Types
export type {
  AgentConfig,
  AuthConfig,
  ModelConfig,
  ModelsConfig,
  McpServerConfig,
  McpServersConfig,
  AgentToolsConfig,
  AgentHooksConfig,
  TaskConfig,
  TaskStep,
  TaskInputField,
  ResolvedAgentConfig,
  FrameworkConfig,
  ExecutionResult,
  UsageSummary,
  CostEntry,
  SessionState,
  LogLevel,
} from "./types/index.js";

// Config
export {
  loadFrameworkConfig,
  loadAgentConfig,
  interpolateEnvVars,
  interpolateVariables,
} from "./config/loader.js";

// Runtime
export { Agent } from "./runtime/agent.js";
export { Executor } from "./runtime/executor.js";
export { McpManager } from "./runtime/mcp-manager.js";

// Model
export { ModelRouter } from "./model/router.js";
export { CostTracker } from "./model/cost-tracker.js";

// Logger
export { Logger } from "./logger/index.js";
