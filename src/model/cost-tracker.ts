import type { CostEntry, UsageSummary } from "../types/index.js";
import type { ModelConfig } from "../types/index.js";

/**
 * Tracks costs per agent, per session, and globally.
 * Supports both estimated costs (from token counts + pricing)
 * and authoritative costs (from SDK result messages).
 */
export class CostTracker {
  private entries: CostEntry[] = [];

  /**
   * Record a cost entry from actual usage.
   */
  record(entry: CostEntry): void {
    this.entries.push(entry);
  }

  /**
   * Estimate cost from token usage and model pricing.
   */
  estimateAndRecord(
    agentName: string,
    model: ModelConfig,
    usage: UsageSummary,
  ): CostEntry {
    const inputCost = (usage.input_tokens / 1_000_000) * model.cost_per_1m_input;
    const outputCost =
      (usage.output_tokens / 1_000_000) * model.cost_per_1m_output;
    const totalCost = inputCost + outputCost;

    const entry: CostEntry = {
      timestamp: new Date(),
      agent_name: agentName,
      model: model.id,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: totalCost,
    };

    this.entries.push(entry);
    return entry;
  }

  /**
   * Get total cost for a specific agent.
   */
  getAgentCost(agentName: string): number {
    return this.entries
      .filter((e) => e.agent_name === agentName)
      .reduce((sum, e) => sum + e.cost_usd, 0);
  }

  /**
   * Get total cost across all agents.
   */
  getTotalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.cost_usd, 0);
  }

  /**
   * Check if an agent has exceeded its budget.
   */
  isOverBudget(agentName: string, budgetUsd: number): boolean {
    return this.getAgentCost(agentName) >= budgetUsd;
  }

  /**
   * Get all entries.
   */
  getEntries(): readonly CostEntry[] {
    return this.entries;
  }

  /**
   * Get a summary of costs by agent.
   */
  getSummary(): Record<string, { cost_usd: number; entries: number }> {
    const summary: Record<string, { cost_usd: number; entries: number }> = {};
    for (const entry of this.entries) {
      if (!summary[entry.agent_name]) {
        summary[entry.agent_name] = { cost_usd: 0, entries: 0 };
      }
      summary[entry.agent_name]!.cost_usd += entry.cost_usd;
      summary[entry.agent_name]!.entries += 1;
    }
    return summary;
  }

  /**
   * Reset all tracked costs.
   */
  reset(): void {
    this.entries = [];
  }
}
