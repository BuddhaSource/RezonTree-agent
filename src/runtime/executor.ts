import type {
  AgentConfig,
  FrameworkConfig,
  TaskConfig,
  ModelConfig,
} from "../types/index.js";
import type { ExecutionResult } from "../types/index.js";
import { Logger } from "../logger/index.js";
import { CostTracker } from "../model/cost-tracker.js";
import { ModelRouter } from "../model/router.js";
import { McpManager } from "./mcp-manager.js";
import { Agent } from "./agent.js";
import { interpolateVariables } from "../config/loader.js";

export interface ExecutorOptions {
  config: FrameworkConfig;
  logger?: Logger;
  costTracker?: CostTracker;
  cwd?: string;
  skillsDir?: string;
}

/**
 * Orchestrates agent execution.
 *
 * Ties together config resolution, model routing, MCP setup,
 * and agent execution into a single entry point.
 */
export class Executor {
  private config: FrameworkConfig;
  private logger: Logger;
  private costTracker: CostTracker;
  private modelRouter: ModelRouter;
  private mcpManager: McpManager;
  private cwd: string;
  private skillsDir?: string;

  constructor(options: ExecutorOptions) {
    this.config = options.config;
    this.logger = options.logger ?? new Logger();
    this.costTracker = options.costTracker ?? new CostTracker();
    this.modelRouter = new ModelRouter(this.config.models);
    this.mcpManager = new McpManager(this.logger);
    this.cwd = options.cwd ?? process.cwd();
    this.skillsDir = options.skillsDir;
  }

  /**
   * Run a named agent with a prompt.
   */
  async runAgent(
    agentName: string,
    prompt: string,
    options?: {
      variables?: Record<string, string>;
      cwd?: string;
      onMessage?: (msg: unknown) => void;
    },
  ): Promise<ExecutionResult> {
    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(
        `Agent "${agentName}" not found. Available: ${Object.keys(this.config.agents).join(", ")}`,
      );
    }

    const agent = this.createAgent(agentConfig);

    return agent.execute({
      prompt,
      variables: options?.variables,
      cwd: options?.cwd ?? this.cwd,
      skillsDir: this.skillsDir,
      onMessage: options?.onMessage,
    });
  }

  /**
   * Run a named task (multi-step workflow).
   * The orchestrator executes each step sequentially, passing context forward.
   */
  async runTask(
    taskName: string,
    input?: Record<string, string>,
  ): Promise<{
    success: boolean;
    context: Record<string, string>;
    results: ExecutionResult[];
    total_cost_usd: number;
  }> {
    const task = this.config.tasks[taskName];
    if (!task) {
      throw new Error(
        `Task "${taskName}" not found. Available: ${Object.keys(this.config.tasks).join(", ")}`,
      );
    }

    this.logger.info(`Starting task: ${task.display_name ?? task.name}`, {
      steps: task.steps.length,
    });

    const context: Record<string, string> = { ...input };
    const results: ExecutionResult[] = [];
    let totalCost = 0;

    for (const step of task.steps) {
      this.logger.info(`Step: ${step.name}`, { agent: step.agent });

      // Interpolate the step prompt with current context
      const prompt = interpolateVariables(step.prompt, context);

      try {
        const result = await this.runAgent(step.agent, prompt, {
          variables: context,
        });

        results.push(result);
        totalCost += result.total_cost_usd;

        if (result.success) {
          context[step.output_key] = result.output;
          this.logger.info(`Step "${step.name}" completed`, {
            cost: result.total_cost_usd,
          });
        } else {
          // Retry once
          this.logger.warn(
            `Step "${step.name}" failed, retrying...`,
            { error: result.error },
          );

          const retry = await this.runAgent(step.agent, prompt, {
            variables: context,
          });

          results.push(retry);
          totalCost += retry.total_cost_usd;

          if (retry.success) {
            context[step.output_key] = retry.output;
          } else if (step.on_failure === "ask_human") {
            this.logger.warn(
              `Step "${step.name}" requires human input`,
            );
            // In a full implementation, this would pause and wait
            context[step.output_key] = `[HUMAN INPUT REQUIRED: ${retry.error}]`;
          } else {
            this.logger.error(`Step "${step.name}" failed permanently`);
            return {
              success: false,
              context,
              results,
              total_cost_usd: totalCost,
            };
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Step "${step.name}" threw: ${errorMsg}`);
        return {
          success: false,
          context,
          results,
          total_cost_usd: totalCost,
        };
      }
    }

    // Interpolate success message
    if (task.on_success) {
      this.logger.info(interpolateVariables(task.on_success, context));
    }

    return {
      success: true,
      context,
      results,
      total_cost_usd: totalCost,
    };
  }

  /**
   * List all available agents.
   */
  listAgents(): Array<{
    name: string;
    display_name?: string;
    description?: string;
    model: string;
  }> {
    return Object.values(this.config.agents).map((a) => ({
      name: a.name,
      display_name: a.display_name,
      description: a.description,
      model: a.model,
    }));
  }

  /**
   * List all available tasks.
   */
  listTasks(): Array<{
    name: string;
    display_name?: string;
    description?: string;
    steps: number;
  }> {
    return Object.entries(this.config.tasks).map(([key, t]) => ({
      name: key,
      display_name: t.display_name,
      description: t.description,
      steps: t.steps.length,
    }));
  }

  /**
   * Get the cost tracker for external reporting.
   */
  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  /**
   * Create an Agent instance from config.
   */
  private createAgent(agentConfig: AgentConfig): Agent {
    // Resolve model
    const modelConfig = this.modelRouter.resolve(agentConfig.model);

    // Resolve fallback model
    let fallbackModel: ModelConfig | undefined;
    if (agentConfig.fallback_model) {
      try {
        fallbackModel = this.modelRouter.resolve(agentConfig.fallback_model);
      } catch {
        this.logger.warn(
          `Fallback model "${agentConfig.fallback_model}" not found for agent "${agentConfig.name}"`,
        );
      }
    }

    // Resolve MCP servers
    const mcpRefs = agentConfig.tools?.mcp ?? [];
    const mcpServers = this.mcpManager.resolveForAgent(
      mcpRefs,
      this.config.mcp_servers,
    );

    return new Agent(
      agentConfig,
      modelConfig,
      mcpServers,
      this.costTracker,
      this.logger,
      fallbackModel,
      this.config.models.auth,
    );
  }
}
