#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { loadFrameworkConfig } from "../config/loader.js";
import { Executor } from "../runtime/executor.js";
import { Logger } from "../logger/index.js";
import { CostTracker } from "../model/cost-tracker.js";
import type { AuthConfig, FrameworkConfig } from "../types/index.js";

const program = new Command();

program
  .name("agentkit")
  .description("Configurable multi-agent orchestrator framework")
  .version("0.1.0");

/**
 * Resolve the config directory. Checks in order:
 * 1. --config flag
 * 2. ./config directory
 * 3. Current directory
 */
function resolveConfigDir(configFlag?: string): string {
  if (configFlag) return resolve(configFlag);

  const localConfig = resolve("config");
  if (existsSync(localConfig)) return localConfig;

  return resolve(".");
}

/**
 * Apply --auth CLI flag to override the models.auth config.
 *
 * Supported values:
 *   oauth           — OAuth via Claude.ai (Pro/Max billing)
 *   oauth:console   — OAuth via Anthropic Console billing
 *   oauth:claudeai  — OAuth via Claude.ai (explicit)
 *   api_key         — API key from env (default)
 *   bedrock         — AWS Bedrock
 *   vertex          — Google Vertex AI
 */
function applyAuthOverride(
  config: FrameworkConfig,
  authFlag?: string,
): FrameworkConfig {
  if (!authFlag) return config;

  let auth: AuthConfig;

  if (authFlag === "oauth" || authFlag === "oauth:claudeai") {
    auth = { method: "oauth", login_method: "claudeai" };
  } else if (authFlag === "oauth:console") {
    auth = { method: "oauth", login_method: "console" };
  } else if (authFlag.startsWith("oauth:org:")) {
    const orgUuid = authFlag.slice("oauth:org:".length);
    auth = { method: "oauth", login_method: "console", org_uuid: orgUuid };
  } else if (authFlag === "bedrock") {
    auth = { method: "bedrock" };
  } else if (authFlag === "vertex") {
    auth = { method: "vertex" };
  } else if (authFlag === "api_key") {
    auth = { method: "api_key" };
  } else {
    throw new Error(
      `Unknown --auth value "${authFlag}". ` +
        `Valid: oauth, oauth:console, oauth:claudeai, oauth:org:<uuid>, api_key, bedrock, vertex`,
    );
  }

  return {
    ...config,
    models: { ...config.models, auth },
  };
}

// ── agentkit run ─────────────────────────────────────────────────────

program
  .command("run")
  .description("Run a task template or free-form prompt")
  .argument("[task]", "Task name (e.g., consensus/create-solution)")
  .option("-p, --prompt <prompt>", "Free-form prompt (used when no task specified)")
  .option("-i, --input <json>", "Input variables as JSON string")
  .option("-c, --config <dir>", "Config directory path")
  .option("--cwd <dir>", "Working directory for agents")
  .option("-v, --verbose", "Enable verbose logging")
  .option("--auth <method>", "Auth method: oauth, oauth:console, api_key, bedrock, vertex")
  .action(async (task: string | undefined, opts) => {
    const logger = new Logger({
      level: opts.verbose ? "debug" : "info",
      format: "pretty",
    });

    try {
      const configDir = resolveConfigDir(opts.config);
      let config = loadFrameworkConfig(configDir);
      config = applyAuthOverride(config, opts.auth);

      const executor = new Executor({
        config,
        logger,
        cwd: opts.cwd ? resolve(opts.cwd) : process.cwd(),
        skillsDir: join(configDir, "..", "skills"),
      });

      if (task) {
        // Run a task template
        const input = opts.input ? JSON.parse(opts.input) : {};
        const result = await executor.runTask(task, input);

        if (result.success) {
          logger.info("Task completed successfully", {
            total_cost_usd: result.total_cost_usd,
          });
        } else {
          logger.error("Task failed");
          process.exitCode = 1;
        }
      } else if (opts.prompt) {
        // Free-form prompt — pick the first available agent or orchestrator
        const agents = executor.listAgents();
        const orchestrator = agents.find((a) => a.name === "orchestrator");
        const agentName = orchestrator?.name ?? agents[0]?.name;

        if (!agentName) {
          logger.error("No agents configured. Add agent configs to config/agents/");
          process.exitCode = 1;
          return;
        }

        const result = await executor.runAgent(agentName, opts.prompt);

        if (result.success) {
          console.log("\n" + result.output);
          logger.info("Done", {
            cost_usd: result.total_cost_usd,
            turns: result.num_turns,
          });
        } else {
          logger.error("Agent failed", { error: result.error });
          process.exitCode = 1;
        }
      } else {
        logger.error("Provide a task name or --prompt");
        process.exitCode = 1;
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── agentkit agent run ───────────────────────────────────────────────

const agentCmd = program.command("agent").description("Manage agents");

agentCmd
  .command("run")
  .description("Run a specific agent directly")
  .argument("<name>", "Agent name")
  .requiredOption("-p, --prompt <prompt>", "Prompt for the agent")
  .option("-c, --config <dir>", "Config directory path")
  .option("--cwd <dir>", "Working directory")
  .option("-v, --verbose", "Enable verbose logging")
  .option("--var <pairs...>", "Variables as key=value pairs")
  .option("--auth <method>", "Auth method: oauth, oauth:console, api_key, bedrock, vertex")
  .action(async (name: string, opts) => {
    const logger = new Logger({
      level: opts.verbose ? "debug" : "info",
      format: "pretty",
    });

    try {
      const configDir = resolveConfigDir(opts.config);
      let config = loadFrameworkConfig(configDir);
      config = applyAuthOverride(config, opts.auth);

      const executor = new Executor({
        config,
        logger,
        cwd: opts.cwd ? resolve(opts.cwd) : process.cwd(),
        skillsDir: join(configDir, "..", "skills"),
      });

      // Parse --var key=value pairs
      const variables: Record<string, string> = {};
      if (opts.var) {
        for (const pair of opts.var as string[]) {
          const [key, ...rest] = pair.split("=");
          if (key) variables[key] = rest.join("=");
        }
      }

      const result = await executor.runAgent(name, opts.prompt, { variables });

      if (result.success) {
        console.log("\n" + result.output);
        logger.info("Done", {
          cost_usd: result.total_cost_usd,
          turns: result.num_turns,
          duration_ms: result.duration_ms,
        });
      } else {
        logger.error("Agent failed", { error: result.error });
        process.exitCode = 1;
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── agentkit agents list ─────────────────────────────────────────────

agentCmd
  .command("list")
  .description("List all configured agents")
  .option("-c, --config <dir>", "Config directory path")
  .action((opts) => {
    try {
      const configDir = resolveConfigDir(opts.config);
      const config = loadFrameworkConfig(configDir);

      const executor = new Executor({ config });
      const agents = executor.listAgents();

      if (agents.length === 0) {
        console.log("No agents configured. Add YAML files to config/agents/");
        return;
      }

      console.log("\nConfigured Agents:\n");
      for (const agent of agents) {
        const name = agent.display_name ?? agent.name;
        const desc = agent.description ?? "";
        console.log(`  ${name.padEnd(25)} ${agent.model.padEnd(12)} ${desc}`);
      }
      console.log();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── agentkit tasks list ──────────────────────────────────────────────

program
  .command("tasks")
  .description("List all configured tasks")
  .option("-c, --config <dir>", "Config directory path")
  .action((opts) => {
    try {
      const configDir = resolveConfigDir(opts.config);
      const config = loadFrameworkConfig(configDir);

      const executor = new Executor({ config });
      const tasks = executor.listTasks();

      if (tasks.length === 0) {
        console.log("No tasks configured. Add YAML files to tasks/");
        return;
      }

      console.log("\nConfigured Tasks:\n");
      for (const task of tasks) {
        const name = task.display_name ?? task.name;
        const desc = task.description ?? "";
        console.log(
          `  ${name.padEnd(30)} ${String(task.steps).padEnd(3)} steps  ${desc}`,
        );
      }
      console.log();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── agentkit validate ────────────────────────────────────────────────

program
  .command("validate")
  .description("Validate all configuration files")
  .option("-c, --config <dir>", "Config directory path")
  .action((opts) => {
    try {
      const configDir = resolveConfigDir(opts.config);
      const config = loadFrameworkConfig(configDir);

      const agentCount = Object.keys(config.agents).length;
      const taskCount = Object.keys(config.tasks).length;
      const modelCount = Object.keys(config.models.models).length;
      const mcpCount = Object.keys(config.mcp_servers.servers).length;

      console.log("\nConfiguration valid!\n");
      console.log(`  Models:      ${modelCount}`);
      console.log(`  MCP Servers: ${mcpCount}`);
      console.log(`  Agents:      ${agentCount}`);
      console.log(`  Tasks:       ${taskCount}`);

      // Validate agent model references
      let warnings = 0;
      for (const agent of Object.values(config.agents)) {
        if (!config.models.models[agent.model]) {
          console.warn(
            `  WARNING: Agent "${agent.name}" references unknown model "${agent.model}"`,
          );
          warnings++;
        }
        if (
          agent.fallback_model &&
          !config.models.models[agent.fallback_model]
        ) {
          console.warn(
            `  WARNING: Agent "${agent.name}" references unknown fallback model "${agent.fallback_model}"`,
          );
          warnings++;
        }
      }

      // Validate task agent references
      for (const [taskKey, task] of Object.entries(config.tasks)) {
        for (const step of task.steps) {
          if (!config.agents[step.agent]) {
            console.warn(
              `  WARNING: Task "${taskKey}" step "${step.name}" references unknown agent "${step.agent}"`,
            );
            warnings++;
          }
        }
      }

      if (warnings > 0) {
        console.log(`\n  ${warnings} warning(s) found.`);
      } else {
        console.log("\n  No warnings.");
      }
      console.log();
    } catch (err) {
      console.error("Validation failed:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── agentkit auth ────────────────────────────────────────────────────

const authCmd = program
  .command("auth")
  .description("Authentication management");

authCmd
  .command("status")
  .description("Show current authentication configuration")
  .option("-c, --config <dir>", "Config directory path")
  .action((opts) => {
    const configDir = resolveConfigDir(opts.config);
    const config = loadFrameworkConfig(configDir);
    const auth = config.models.auth;

    console.log("\nAuthentication Configuration:\n");

    if (!auth) {
      const hasOpenRouter = !!process.env["OPENROUTER_API_KEY"];
      const hasAnthropic = !!process.env["ANTHROPIC_API_KEY"];

      console.log("  Method:     api_key (default)");
      console.log(
        `  OPENROUTER_API_KEY: ${hasOpenRouter ? "set" : "not set"}`,
      );
      console.log(
        `  ANTHROPIC_API_KEY:  ${hasAnthropic ? "set" : "not set"}`,
      );

      if (!hasOpenRouter && !hasAnthropic) {
        console.log(
          "\n  No API keys found. Set one in .env or use --auth oauth",
        );
      }
    } else {
      console.log(`  Method:       ${auth.method}`);
      if (auth.method === "oauth") {
        console.log(
          `  Login method: ${auth.login_method ?? "console"}`,
        );
        if (auth.org_uuid) {
          console.log(`  Organization: ${auth.org_uuid}`);
        }
        console.log(
          "\n  OAuth uses Claude Code's cached credentials.",
        );
        console.log(
          "  Run 'claude login' if you haven't authenticated yet.",
        );
      } else if (auth.method === "bedrock") {
        console.log("  Using AWS credentials from environment.");
      } else if (auth.method === "vertex") {
        console.log("  Using Google Cloud credentials from environment.");
      }
    }

    console.log("\n  Override per-run with: --auth oauth|oauth:console|api_key|bedrock|vertex\n");
  });

authCmd
  .command("set")
  .description("Set auth method in models.yaml")
  .argument(
    "<method>",
    "Auth method: oauth, oauth:console, oauth:claudeai, api_key, bedrock, vertex",
  )
  .option("-c, --config <dir>", "Config directory path")
  .option("--org <uuid>", "Organization UUID for OAuth")
  .action(async (method: string, opts) => {
    const configDir = resolveConfigDir(opts.config);
    const modelsPath = join(configDir, "models.yaml");

    if (!existsSync(modelsPath)) {
      console.error(`models.yaml not found at ${modelsPath}`);
      process.exitCode = 1;
      return;
    }

    // Build the auth YAML block
    let authBlock: string;

    if (method === "oauth" || method === "oauth:claudeai") {
      authBlock = `auth:\n  method: oauth\n  login_method: claudeai`;
      if (opts.org) authBlock += `\n  org_uuid: "${opts.org}"`;
    } else if (method === "oauth:console") {
      authBlock = `auth:\n  method: oauth\n  login_method: console`;
      if (opts.org) authBlock += `\n  org_uuid: "${opts.org}"`;
    } else if (method === "api_key") {
      authBlock = `auth:\n  method: api_key`;
    } else if (method === "bedrock") {
      authBlock = `auth:\n  method: bedrock`;
    } else if (method === "vertex") {
      authBlock = `auth:\n  method: vertex`;
    } else {
      console.error(
        `Unknown auth method "${method}". Valid: oauth, oauth:console, oauth:claudeai, api_key, bedrock, vertex`,
      );
      process.exitCode = 1;
      return;
    }

    // Read and update models.yaml
    const { readFileSync: readSync, writeFileSync: writeSync } = await import("node:fs");
    let content = readSync(modelsPath, "utf-8") as string;

    // Replace existing auth block or insert before 'models:'
    const authRegex = /^auth:\n(?:  .+\n)*/m;
    if (authRegex.test(content)) {
      content = content.replace(authRegex, authBlock + "\n");
    } else {
      content = content.replace(/^(models:)/m, authBlock + "\n\n$1");
    }

    writeSync(modelsPath, content, "utf-8");
    console.log(`Auth method set to "${method}" in ${modelsPath}`);
  });

program.parse();
