import { z } from "zod";

// ── Model Schemas ────────────────────────────────────────────────────

export const ModelConfigSchema = z.object({
  id: z.string(),
  tier: z.enum(["premium", "standard", "budget"]),
  cost_per_1m_input: z.number(),
  cost_per_1m_output: z.number(),
  use_for: z.string().optional(),
});

export const AuthConfigSchema = z.object({
  method: z.enum(["api_key", "oauth", "bedrock", "vertex"]),
  login_method: z.enum(["claudeai", "console"]).optional(),
  org_uuid: z.string().optional(),
  api_key_env: z.string().optional(),
});

export const ModelsConfigSchema = z.object({
  provider: z.string().default("openrouter"),
  base_url: z.string().default("https://openrouter.ai/api/v1"),
  auth: AuthConfigSchema.optional(),
  models: z.record(z.string(), ModelConfigSchema),
  tiers: z.record(z.string(), z.array(z.string())).optional().default({}),
});

// ── MCP Server Schemas ───────────────────────────────────────────────

const McpServerStdioSchema = z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
});

const McpServerHttpSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
});

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  McpServerStdioSchema,
  McpServerHttpSchema,
]);

export const McpServersConfigSchema = z.object({
  servers: z.record(z.string(), McpServerConfigSchema),
});

// ── Agent Schemas ────────────────────────────────────────────────────

export const AgentToolsConfigSchema = z.object({
  builtin: z.array(z.string()).optional(),
  mcp: z.array(z.string()).optional(),
});

export const AgentHooksConfigSchema = z.object({
  pre_tool_use: z.array(z.string()).optional(),
  post_tool_use: z.array(z.string()).optional(),
});

export const AgentConfigSchema = z.object({
  name: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  model: z.string(),
  fallback_model: z.string().optional(),
  system_prompt: z.string(),
  skills: z.array(z.string()).optional(),
  tools: AgentToolsConfigSchema.optional(),
  max_turns: z.number().int().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  timeout_seconds: z.number().int().positive().optional(),
  output_format: z.string().optional(),
  hooks: AgentHooksConfigSchema.optional(),
});

// ── Task Schemas ─────────────────────────────────────────────────────

export const TaskInputFieldSchema = z.object({
  type: z.string(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

export const TaskStepSchema = z.object({
  name: z.string(),
  agent: z.string(),
  prompt: z.string(),
  output_key: z.string(),
  on_failure: z.string().optional(),
});

export const TaskConfigSchema = z.object({
  name: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  input: z.record(z.string(), TaskInputFieldSchema).optional(),
  steps: z.array(TaskStepSchema),
  on_success: z.string().optional(),
  on_failure: z.string().optional(),
});
