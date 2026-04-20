/**
 * Configuration types for AgentKit.
 * These define the shape of YAML config files and the runtime config objects.
 */

// ── Model Configuration ──────────────────────────────────────────────

export interface ModelConfig {
  id: string;
  tier: "premium" | "standard" | "budget";
  cost_per_1m_input: number;
  cost_per_1m_output: number;
  use_for?: string;
}

/**
 * Authentication configuration for the model provider.
 *
 * Supports three modes:
 * - "api_key"  — Use ANTHROPIC_API_KEY or OPENROUTER_API_KEY from env
 * - "oauth"    — Use Anthropic's OAuth flow (browser-based login)
 * - "bedrock" / "vertex" — Cloud provider auth
 */
export interface AuthConfig {
  method: "api_key" | "oauth" | "bedrock" | "vertex";

  /** For OAuth: "claudeai" (Pro/Max billing) or "console" (API Console billing) */
  login_method?: "claudeai" | "console";

  /** For OAuth: organization UUID to authenticate against */
  org_uuid?: string;

  /** For API key: env var name to read the key from (default: ANTHROPIC_API_KEY or OPENROUTER_API_KEY) */
  api_key_env?: string;
}

export interface ModelsConfig {
  provider: string;
  base_url: string;
  auth?: AuthConfig;
  models: Record<string, ModelConfig>;
  tiers: Record<string, string[]>;
}

// ── MCP Server Configuration ─────────────────────────────────────────

export interface McpServerStdio {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
}

export interface McpServerHttp {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  description?: string;
}

export type McpServerConfig = McpServerStdio | McpServerHttp;

export interface McpServersConfig {
  servers: Record<string, McpServerConfig>;
}

// ── Agent Configuration ──────────────────────────────────────────────

export interface AgentToolsConfig {
  builtin?: string[];
  mcp?: string[];
}

export interface AgentHooksConfig {
  pre_tool_use?: string[];
  post_tool_use?: string[];
}

export interface AgentConfig {
  name: string;
  display_name?: string;
  description?: string;

  model: string;
  fallback_model?: string;

  system_prompt: string;
  skills?: string[];

  tools?: AgentToolsConfig;
  max_turns?: number;
  max_budget_usd?: number;
  timeout_seconds?: number;
  output_format?: string;
  hooks?: AgentHooksConfig;
}

// ── Task Configuration ───────────────────────────────────────────────

export interface TaskInputField {
  type: string;
  required?: boolean;
  description?: string;
}

export interface TaskStep {
  name: string;
  agent: string;
  prompt: string;
  output_key: string;
  on_failure?: string;
}

export interface TaskConfig {
  name: string;
  display_name?: string;
  description?: string;
  input?: Record<string, TaskInputField>;
  steps: TaskStep[];
  on_success?: string;
  on_failure?: string;
}

// ── Resolved Runtime Config ──────────────────────────────────────────

/**
 * Fully resolved agent config with model details populated.
 */
export interface ResolvedAgentConfig extends AgentConfig {
  resolved_model: ModelConfig;
  resolved_fallback_model?: ModelConfig;
  resolved_mcp_servers: Record<string, McpServerConfig>;
  resolved_skills: string[];
}

/**
 * Complete framework configuration, fully loaded and validated.
 */
export interface FrameworkConfig {
  models: ModelsConfig;
  mcp_servers: McpServersConfig;
  agents: Record<string, AgentConfig>;
  tasks: Record<string, TaskConfig>;
}
