import type { LogLevel, CostEntry } from "../types/index.js";
import type { CostTracker } from "../model/cost-tracker.js";

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  agent?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: "json" | "pretty";
  costTracker?: CostTracker;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Structured logger with cost tracking integration.
 * Supports JSON output for machines and pretty output for humans.
 */
export class Logger {
  private level: number;
  private format: "json" | "pretty";
  private agentName?: string;
  private costTracker?: CostTracker;

  constructor(options: LoggerOptions = {}) {
    this.level = LOG_LEVELS[options.level ?? "info"];
    this.format = options.format ?? "pretty";
    this.costTracker = options.costTracker;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= this.level;
  }

  private write(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    if (this.format === "json") {
      const line = JSON.stringify(entry);
      if (entry.level === "error") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
      return;
    }

    // Pretty format
    const prefix = this.agentName ? `[${this.agentName}]` : "";
    const levelTag = entry.level.toUpperCase().padEnd(5);
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
    const line = `${levelTag} ${prefix} ${entry.message}${dataStr}`;

    if (entry.level === "error") {
      console.error(line);
    } else if (entry.level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write({
      level: "debug",
      timestamp: new Date().toISOString(),
      agent: this.agentName,
      message,
      data,
    });
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write({
      level: "info",
      timestamp: new Date().toISOString(),
      agent: this.agentName,
      message,
      data,
    });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write({
      level: "warn",
      timestamp: new Date().toISOString(),
      agent: this.agentName,
      message,
      data,
    });
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write({
      level: "error",
      timestamp: new Date().toISOString(),
      agent: this.agentName,
      message,
      data,
    });
  }

  /**
   * Create a child logger scoped to a specific agent.
   */
  child(agentName: string): Logger {
    const child = new Logger({
      level: (Object.entries(LOG_LEVELS).find(
        ([, v]) => v === this.level,
      )?.[0] ?? "info") as LogLevel,
      format: this.format,
      costTracker: this.costTracker,
    });
    child.agentName = agentName;
    return child;
  }

  /**
   * Log a cost event.
   */
  logCost(entry: CostEntry): void {
    this.info("Cost recorded", {
      agent: entry.agent_name,
      model: entry.model,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      cost_usd: entry.cost_usd,
      total_cost_usd: this.costTracker?.getTotalCost(),
    });
  }
}
