/**
 * Runtime types for agent execution, results, and cost tracking.
 */

export interface ExecutionResult {
  agent_name: string;
  session_id: string;
  success: boolean;
  output: string;
  error?: string;
  duration_ms: number;
  total_cost_usd: number;
  usage: UsageSummary;
  num_turns: number;
}

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostEntry {
  timestamp: Date;
  agent_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface SessionState {
  id: string;
  created_at: Date;
  updated_at: Date;
  status: "running" | "paused" | "completed" | "failed";
  agent_name: string;
  task_name?: string;
  context: Record<string, unknown>;
  cost_usd: number;
  messages: unknown[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";
