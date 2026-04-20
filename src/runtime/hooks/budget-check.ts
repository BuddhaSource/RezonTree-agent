import type { CostTracker } from "../../model/cost-tracker.js";
import type { Logger } from "../../logger/index.js";

/**
 * Pre-tool-use hook that checks if the agent has exceeded its budget.
 * Returns a deny decision if over budget.
 */
export function createBudgetCheckHook(
  agentName: string,
  maxBudgetUsd: number,
  costTracker: CostTracker,
  logger: Logger,
) {
  return async () => {
    const currentCost = costTracker.getAgentCost(agentName);
    if (currentCost >= maxBudgetUsd) {
      logger.warn(`Budget exceeded for agent "${agentName}"`, {
        current: currentCost,
        max: maxBudgetUsd,
      });
      return {
        decision: "deny" as const,
        reason: `Budget exceeded: $${currentCost.toFixed(4)} >= $${maxBudgetUsd.toFixed(2)}`,
      };
    }
    return { decision: "allow" as const };
  };
}
