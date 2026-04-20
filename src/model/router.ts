import type { ModelConfig, ModelsConfig } from "../types/index.js";

export interface ResolvedModel {
  modelId: string;
  apiKey: string;
  baseUrl: string;
  pricing: ModelConfig;
}

/**
 * Resolves model aliases to full model configurations
 * and provides API connection details for OpenRouter.
 */
export class ModelRouter {
  constructor(private config: ModelsConfig) {}

  /**
   * Resolve a model alias (e.g., "sonnet") to a full model config.
   */
  resolve(alias: string): ModelConfig {
    const model = this.config.models[alias];
    if (!model) {
      throw new Error(
        `Unknown model alias "${alias}". Available: ${Object.keys(this.config.models).join(", ")}`,
      );
    }
    return model;
  }

  /**
   * Get the full connection details for a model, ready for API calls.
   */
  getConnectionDetails(alias: string): ResolvedModel {
    const model = this.resolve(alias);
    const apiKey = process.env["OPENROUTER_API_KEY"];

    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY environment variable is required. " +
          "Get one at https://openrouter.ai/keys",
      );
    }

    return {
      modelId: model.id,
      apiKey,
      baseUrl: this.config.base_url,
      pricing: model,
    };
  }

  /**
   * Get all models in a specific tier.
   */
  getModelsByTier(tier: string): ModelConfig[] {
    const aliases = this.config.tiers[tier] ?? [];
    return aliases.map((alias) => this.resolve(alias));
  }

  /**
   * Pick the cheapest model from a tier.
   */
  getCheapestInTier(tier: string): ModelConfig | undefined {
    const models = this.getModelsByTier(tier);
    return models.sort(
      (a, b) => a.cost_per_1m_input + a.cost_per_1m_output -
        (b.cost_per_1m_input + b.cost_per_1m_output),
    )[0];
  }

  /**
   * List all available model aliases.
   */
  listModels(): Array<{ alias: string; model: ModelConfig }> {
    return Object.entries(this.config.models).map(([alias, model]) => ({
      alias,
      model,
    }));
  }
}
