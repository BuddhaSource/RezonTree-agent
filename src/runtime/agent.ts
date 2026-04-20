import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentConfig,
  AuthConfig,
  ModelConfig,
  McpServerConfig,
  ResolvedAgentConfig,
} from "../types/index.js";
import type { ExecutionResult, UsageSummary } from "../types/index.js";
import type { Logger } from "../logger/index.js";
import type { CostTracker } from "../model/cost-tracker.js";
import type { McpManager, SdkMcpServerConfig } from "./mcp-manager.js";
import { interpolateVariables } from "../config/loader.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Maps short Anthropic model aliases to full dated model IDs required by
 * the Claude Agent SDK (which spawns Claude Code internally).
 */
const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4": "claude-opus-4-20250514",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-haiku-4": "claude-haiku-4-20250506",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export interface AgentRunOptions {
  /** The prompt / task for the agent */
  prompt: string;
  /** Variables for {{template}} interpolation in prompt and system_prompt */
  variables?: Record<string, string>;
  /** Working directory for the agent */
  cwd?: string;
  /** Skills directory path (for loading skill files) */
  skillsDir?: string;
  /** Callback for each message from the agent */
  onMessage?: (message: unknown) => void;
  /** AbortController for cancellation */
  abortController?: AbortController;
}

/**
 * Wraps the Claude Agent SDK `query()` function with AgentKit config.
 *
 * Each Agent instance represents a configured role (researcher, solver, etc.)
 * and translates YAML config into SDK options. The SDK handles:
 * - The agentic loop (tool use → response → tool use...)
 * - MCP server lifecycle
 * - Built-in tools (Read, Write, Bash, Glob, Grep, etc.)
 * - Cost tracking via result messages
 */
export class Agent {
  readonly name: string;
  private logger: Logger;

  constructor(
    readonly config: AgentConfig,
    private modelConfig: ModelConfig,
    private mcpServers: Record<string, SdkMcpServerConfig>,
    private costTracker: CostTracker,
    logger: Logger,
    private fallbackModelConfig?: ModelConfig,
    private authConfig?: AuthConfig,
  ) {
    this.name = config.name;
    this.logger = logger.child(config.name);
  }

  /**
   * Execute the agent with a prompt and return structured results.
   */
  async execute(options: AgentRunOptions): Promise<ExecutionResult> {
    const sessionId = randomUUID();
    const startTime = Date.now();

    // Interpolate variables in prompt
    const prompt = options.variables
      ? interpolateVariables(options.prompt, options.variables)
      : options.prompt;

    // Build system prompt with skills appended
    const systemPrompt = this.buildSystemPrompt(
      options.variables,
      options.skillsDir,
    );

    this.logger.info(`Starting execution`, {
      model: this.modelConfig.id,
      prompt_length: prompt.length,
    });

    const usage: UsageSummary = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    let output = "";
    let success = false;
    let error: string | undefined;
    let numTurns = 0;
    let totalCostUsd = 0;

    try {
      const sdkOptions = this.buildSdkOptions(systemPrompt, options);

      const conversation = query({ prompt, options: sdkOptions });

      for await (const message of conversation) {
        // Forward to callback if provided
        options.onMessage?.(message);

        switch (message.type) {
          case "assistant": {
            numTurns++;
            // Extract text content from the assistant message
            const assistantMsg = message as {
              type: "assistant";
              message: {
                content: Array<{ type: string; text?: string }>;
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                };
              };
            };

            for (const block of assistantMsg.message.content) {
              if (block.type === "text" && block.text) {
                output += block.text;
              }
            }

            // Accumulate usage
            if (assistantMsg.message.usage) {
              usage.input_tokens +=
                assistantMsg.message.usage.input_tokens ?? 0;
              usage.output_tokens +=
                assistantMsg.message.usage.output_tokens ?? 0;
              usage.cache_read_tokens +=
                assistantMsg.message.usage.cache_read_input_tokens ?? 0;
              usage.cache_write_tokens +=
                assistantMsg.message.usage.cache_creation_input_tokens ?? 0;
            }
            break;
          }

          case "result": {
            const resultMsg = message as {
              type: "result";
              subtype: string;
              total_cost_usd?: number;
              duration_ms?: number;
              session_id?: string;
            };

            if (resultMsg.subtype === "success") {
              success = true;
            } else {
              success = false;
              error = `Agent ended with error: ${resultMsg.subtype}`;
            }

            if (resultMsg.total_cost_usd !== undefined) {
              totalCostUsd = resultMsg.total_cost_usd;
            }
            break;
          }
        }
      }

      // Record cost
      if (totalCostUsd > 0) {
        this.costTracker.record({
          timestamp: new Date(),
          agent_name: this.name,
          model: this.modelConfig.id,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cost_usd: totalCostUsd,
        });
      } else {
        // Estimate cost from token usage if SDK didn't provide it
        const entry = this.costTracker.estimateAndRecord(
          this.name,
          this.modelConfig,
          usage,
        );
        totalCostUsd = entry.cost_usd;
      }

      this.logger.info(`Execution complete`, {
        success,
        turns: numTurns,
        cost_usd: totalCostUsd,
        duration_ms: Date.now() - startTime,
      });
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Execution failed: ${error}`);
    }

    return {
      agent_name: this.name,
      session_id: sessionId,
      success,
      output,
      error,
      duration_ms: Date.now() - startTime,
      total_cost_usd: totalCostUsd,
      usage,
      num_turns: numTurns,
    };
  }

  /**
   * Build SDK Options from AgentKit config.
   *
   * Auth modes:
   * - "oauth"   → uses forceLoginMethod, no API key env vars needed
   * - "api_key"  → passes ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) via env
   * - "bedrock"  → sets CLAUDE_CODE_USE_BEDROCK=1
   * - "vertex"   → sets CLAUDE_CODE_USE_VERTEX=1
   */
  private buildSdkOptions(
    systemPrompt: string,
    runOptions: AgentRunOptions,
  ): Record<string, unknown> {
    // Resolve model ID. For direct Anthropic access (OAuth, Bedrock, Vertex,
    // or api_key with an Anthropic key), strip OpenRouter-style provider
    // prefixes (e.g., "anthropic/claude-sonnet-4" → "claude-sonnet-4")
    // and resolve short aliases to full dated IDs required by the SDK.
    const authMethod = this.authConfig?.method ?? "api_key";
    let modelId = this.modelConfig.id;
    const isDirectAnthropic =
      authMethod !== "api_key" ||
      (process.env["ANTHROPIC_API_KEY"]?.startsWith("sk-ant-") &&
        !process.env["OPENROUTER_API_KEY"]);
    if (isDirectAnthropic && modelId.includes("/")) {
      modelId = modelId.split("/").pop()!;
    }
    // Resolve short aliases to full dated model IDs
    if (isDirectAnthropic && ANTHROPIC_MODEL_ALIASES[modelId]) {
      modelId = ANTHROPIC_MODEL_ALIASES[modelId];
    }

    this.logger.debug(`Resolved model ID: ${modelId}`, {
      original: this.modelConfig.id,
      isDirectAnthropic,
    });

    const options: Record<string, unknown> = {
      model: modelId,
      systemPrompt,
      maxTurns: this.config.max_turns,
      maxBudgetUsd: this.config.max_budget_usd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: runOptions.cwd ?? process.cwd(),
      pathToClaudeCodeExecutable:
        process.env["CLAUDE_CODE_PATH"] ?? "/Users/siddharth/.local/bin/claude",
    };

    // Configure allowed tools
    const allowedTools: string[] = [];
    if (this.config.tools?.builtin) {
      allowedTools.push(...this.config.tools.builtin);
    }
    if (this.config.tools?.mcp) {
      for (const serverName of this.config.tools.mcp) {
        allowedTools.push(`mcp__${serverName}__*`);
      }
    }
    if (allowedTools.length > 0) {
      options.allowedTools = allowedTools;
    }

    // Configure MCP servers
    if (Object.keys(this.mcpServers).length > 0) {
      options.mcpServers = this.mcpServers;
    }

    // ── Authentication ───────────────────────────────────────────────
    // Build a clean base env: inherit process.env but strip Claude Code
    // session markers to avoid "cannot launch inside another session" errors.
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k === "CLAUDE_CODE_ENTRYPOINT") continue;
      if (v !== undefined) baseEnv[k] = v;
    }

    switch (authMethod) {
      case "oauth": {
        // OAuth: SDK handles browser-based login via Claude Code's auth system.
        // No API key env vars needed — the SDK uses cached OAuth tokens.
        options.forceLoginMethod =
          this.authConfig?.login_method ?? "console";
        if (this.authConfig?.org_uuid) {
          options.forceLoginOrgUUID = this.authConfig.org_uuid;
        }
        options.env = baseEnv;
        this.logger.debug("Using OAuth authentication", {
          login_method: options.forceLoginMethod,
          org_uuid: this.authConfig?.org_uuid,
        });
        break;
      }

      case "bedrock": {
        // AWS Bedrock: auth via AWS credentials in environment
        options.env = {
          ...baseEnv,
          CLAUDE_CODE_USE_BEDROCK: "1",
        };
        this.logger.debug("Using AWS Bedrock authentication");
        break;
      }

      case "vertex": {
        // Google Vertex AI: auth via Google credentials in environment
        options.env = {
          ...baseEnv,
          CLAUDE_CODE_USE_VERTEX: "1",
        };
        this.logger.debug("Using Google Vertex AI authentication");
        break;
      }

      case "api_key":
      default: {
        // API key: resolve from env var (supports OpenRouter or direct Anthropic)
        const keyEnvVar =
          this.authConfig?.api_key_env ?? "ANTHROPIC_API_KEY";
        const apiKey =
          process.env[keyEnvVar] ??
          process.env["OPENROUTER_API_KEY"] ??
          process.env["ANTHROPIC_API_KEY"] ??
          "";

        const env: Record<string, string> = { ...baseEnv };

        // OAuth access tokens (sk-ant-oat*) are NOT valid API keys.
        // Claude Code rejects them as "Invalid API key". Instead, remove
        // ANTHROPIC_API_KEY from env so Claude Code uses its cached OAuth session.
        if (apiKey.startsWith("sk-ant-oat")) {
          delete env["ANTHROPIC_API_KEY"];
          this.logger.debug(
            "Detected OAuth access token — using Claude Code cached session",
          );
        } else if (apiKey) {
          env["ANTHROPIC_API_KEY"] = apiKey;
        }

        // If using OpenRouter, set the base URL
        if (
          process.env["OPENROUTER_API_KEY"] &&
          !process.env["ANTHROPIC_API_KEY"]
        ) {
          env["ANTHROPIC_BASE_URL"] =
            process.env["OPENROUTER_BASE_URL"] ??
            "https://openrouter.ai/api/v1";
        }

        options.env = env;
        this.logger.debug("Using API key authentication", {
          key_source: keyEnvVar,
          has_key: apiKey.length > 0,
          is_oauth_token: apiKey.startsWith("sk-ant-oat"),
        });
        break;
      }
    }

    // Abort controller
    if (runOptions.abortController) {
      options.abortController = runOptions.abortController;
    }

    return options;
  }

  /**
   * Build the full system prompt by combining the base prompt with loaded skills.
   */
  private buildSystemPrompt(
    variables?: Record<string, string>,
    skillsDir?: string,
  ): string {
    let prompt = this.config.system_prompt;

    // Interpolate variables in system prompt
    if (variables) {
      prompt = interpolateVariables(prompt, variables);
    }

    // Append skills
    if (this.config.skills && skillsDir) {
      for (const skillName of this.config.skills) {
        const skillPath = join(skillsDir, `${skillName}.md`);
        if (existsSync(skillPath)) {
          const skillContent = readFileSync(skillPath, "utf-8");
          prompt += `\n\n--- Skill: ${skillName} ---\n${skillContent}`;
        }
      }
    }

    return prompt;
  }
}
