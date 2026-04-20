import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AgentConfigSchema,
  ModelsConfigSchema,
  McpServersConfigSchema,
  TaskConfigSchema,
} from "./schema.js";
import { applyAgentDefaults } from "./defaults.js";
import type {
  AgentConfig,
  ModelsConfig,
  McpServersConfig,
  TaskConfig,
  FrameworkConfig,
  McpServerConfig,
} from "../types/index.js";

/**
 * Interpolate ${ENV_VAR} patterns with process.env values.
 * Supports ${ENV_VAR:-default} syntax for defaults.
 */
export function interpolateEnvVars(input: string): string {
  return input.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
    const [varName, defaultValue] = expr.split(":-");
    const value = process.env[varName!.trim()];
    if (value !== undefined) return value;
    if (defaultValue !== undefined) return defaultValue;
    return match; // leave unresolved if no env var and no default
  });
}

/**
 * Interpolate {{variable}} patterns with provided values.
 * Used at task execution time, not config load time.
 */
export function interpolateVariables(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName: string) => {
    return variables[varName] ?? match;
  });
}

/**
 * Deep-walk an object and interpolate all string values for env vars.
 */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(interpolateDeep);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Read and parse a YAML file with env var interpolation.
 */
function loadYamlFile<T>(filePath: string): T {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  return interpolateDeep(parsed) as T;
}

/**
 * Load all YAML files from a directory, keyed by their `name` field.
 */
function loadYamlDirectory<T extends { name: string }>(
  dirPath: string,
  validate: (data: unknown) => T,
): Record<string, T> {
  const result: Record<string, T> = {};

  if (!existsSync(dirPath)) return result;

  for (const file of readdirSync(dirPath)) {
    if (![".yaml", ".yml"].includes(extname(file))) continue;
    const filePath = join(dirPath, file);
    const raw = loadYamlFile<unknown>(filePath);
    const validated = validate(raw);
    result[validated.name] = validated;
  }

  return result;
}

/**
 * Load tasks from a directory tree (supports nested directories like tasks/consensus/).
 */
function loadTasksRecursive(
  dirPath: string,
  validate: (data: unknown) => TaskConfig,
): Record<string, TaskConfig> {
  const result: Record<string, TaskConfig> = {};

  if (!existsSync(dirPath)) return result;

  for (const entry of readdirSync(dirPath)) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const nested = loadTasksRecursive(fullPath, validate);
      // Prefix nested tasks with directory name
      for (const [name, task] of Object.entries(nested)) {
        result[`${entry}/${name}`] = task;
      }
    } else if ([".yaml", ".yml"].includes(extname(entry))) {
      const raw = loadYamlFile<unknown>(fullPath);
      const validated = validate(raw);
      result[validated.name] = validated;
    }
  }

  return result;
}

/**
 * Infer MCP server type from config shape when `type` is not explicit.
 */
function normalizeMcpServer(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (raw["type"]) return raw;

  // Infer type from fields present
  if (raw["command"]) return { ...raw, type: "stdio" };
  if (raw["url"]) return { ...raw, type: "http" };

  return { ...raw, type: "stdio" };
}

/**
 * Load the complete framework configuration from a config directory.
 *
 * Expected structure:
 *   configDir/
 *     models.yaml
 *     mcp-servers.yaml
 *     agents/
 *       orchestrator.yaml
 *       researcher.yaml
 *       ...
 *
 *   tasksDir/ (separate, defaults to ./tasks)
 *     consensus/
 *       create-solution.yaml
 *     general/
 *       research.yaml
 */
export function loadFrameworkConfig(
  configDir: string,
  tasksDir?: string,
): FrameworkConfig {
  // Load models
  const modelsPath = join(configDir, "models.yaml");
  let models: ModelsConfig = {
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    models: {},
    tiers: {},
  };
  if (existsSync(modelsPath)) {
    const raw = loadYamlFile<unknown>(modelsPath);
    models = ModelsConfigSchema.parse(raw);
  }

  // Load MCP servers
  const mcpPath = join(configDir, "mcp-servers.yaml");
  let mcpServers: McpServersConfig = { servers: {} };
  if (existsSync(mcpPath)) {
    const raw = loadYamlFile<Record<string, unknown>>(mcpPath);
    // Normalize server configs to include type field
    if (raw["servers"] && typeof raw["servers"] === "object") {
      const servers = raw["servers"] as Record<string, Record<string, unknown>>;
      for (const [key, server] of Object.entries(servers)) {
        servers[key] = normalizeMcpServer(server);
      }
    }
    mcpServers = McpServersConfigSchema.parse(raw);
  }

  // Load agents
  const agentsDir = join(configDir, "agents");
  const agents = loadYamlDirectory<AgentConfig>(agentsDir, (data) => {
    const parsed = AgentConfigSchema.parse(data);
    return applyAgentDefaults(parsed);
  });

  // Load tasks
  const resolvedTasksDir = tasksDir ?? join(configDir, "..", "tasks");
  const tasks = loadTasksRecursive(resolvedTasksDir, (data) =>
    TaskConfigSchema.parse(data),
  );

  return { models, mcp_servers: mcpServers, agents, tasks };
}

/**
 * Load a single agent config from a YAML file.
 */
export function loadAgentConfig(filePath: string): AgentConfig {
  const raw = loadYamlFile<unknown>(filePath);
  const parsed = AgentConfigSchema.parse(raw);
  return applyAgentDefaults(parsed);
}

/**
 * Resolve an agent's MCP server references against the global MCP registry.
 */
export function resolveAgentMcpServers(
  agent: AgentConfig,
  globalServers: McpServersConfig,
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  const mcpRefs = agent.tools?.mcp ?? [];

  for (const ref of mcpRefs) {
    const server = globalServers.servers[ref];
    if (server) {
      result[ref] = server;
    }
  }

  return result;
}
