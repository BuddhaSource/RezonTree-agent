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
 * const result = await executor.runAgent("researcher", "Analyze this question...");
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

// ── RezonTree protocol surface (for agent authors) ───────────────────
// Get-started: turn (specialization, team, blend) into a launch plan.
export {
  buildOnboardPlan,
  runOnboard,
  renderOnboardPlan,
  assignPersonas,
  AGENT_NAME_POOL,
  MAX_TEAM_SIZE,
  type Blend,
  type OnboardAnswers,
  type OnboardPlan,
  type RosterAgent,
} from "./bootstrap/onboard.js";

// Persona × specialization model (drives swarm behavior + topics + coaching).
export {
  PERSONAS,
  SPECIALIZATIONS,
  resolvePersona,
  resolveSpecialization,
  DEFAULT_PERSONA,
  DEFAULT_SPECIALIZATION,
  type Persona,
  type Specialization,
  type ActionWeights,
} from "./personas/registry.js";

// Wallet login — sign a WalletLoginIntent, get a JWT (one cache per process).
export {
  loginWallet,
  sessionManagerFor,
  buildWalletBank,
  type DerivedWallet,
} from "./wallet/login.js";

// Heartbeat monitor — what to act on next + a human progress report.
export {
  collectSnapshot,
  diffSnapshots,
  renderReport,
  buildPersuasion,
  toRecord,
  MIN_INTERVAL_MS,
  type Snapshot,
  type SnapshotDelta,
  type HeartbeatRecord,
  type BoardItem,
} from "./monitoring/heartbeat.js";

// Swarm decision policy (run duration + weighted action menu).
export {
  resolveDeadlineMs,
  buildActionMenu,
  type MenuInputs,
} from "./swarm/policy.js";

// Prediction markets — frame a market as a calibrated-probability question
// whose round closes before the market resolves.
export {
  buildPredictionQuestion,
  computeRoundTiming,
  MIN_MARKET_WINDOW_SEC,
  DEFAULT_ROUND_BUFFER_SEC,
  type PredictionMarket,
  type PredictionQuestion,
  type RoundTiming,
} from "./markets/prediction-question.js";
export {
  polymarketSource,
  parseGammaMarket,
  filterClosingWindow,
  GAMMA_MARKETS_URL,
  type MarketSource,
  type ClosingWindowOpts,
  type FetchJson,
} from "./markets/polymarket.js";
