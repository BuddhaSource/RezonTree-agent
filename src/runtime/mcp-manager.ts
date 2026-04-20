import type { McpServerConfig, McpServersConfig } from "../types/index.js";
import type { Logger } from "../logger/index.js";
import { interpolateEnvVars } from "../config/loader.js";

/**
 * MCP server config in the format expected by the Claude Agent SDK.
 * The SDK accepts servers as Record<string, SdkMcpServerConfig>.
 */
export interface SdkMcpServerConfig {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Manages MCP server configurations for agents.
 *
 * The Claude Agent SDK handles actual server lifecycle (start/stop).
 * This manager transforms AgentKit config into SDK-compatible format,
 * resolving env vars and validating configs.
 */
export class McpManager {
  constructor(private logger: Logger) {}

  /**
   * Resolve agent MCP server references into SDK-compatible configs.
   * Takes the agent's MCP tool list and the global server registry,
   * and returns configs ready to pass to the SDK.
   */
  resolveForAgent(
    mcpToolRefs: string[],
    globalServers: McpServersConfig,
  ): Record<string, SdkMcpServerConfig> {
    const result: Record<string, SdkMcpServerConfig> = {};

    for (const ref of mcpToolRefs) {
      const serverConfig = globalServers.servers[ref];
      if (!serverConfig) {
        this.logger.warn(`MCP server "${ref}" not found in registry, skipping`);
        continue;
      }

      result[ref] = this.toSdkFormat(ref, serverConfig);
    }

    return result;
  }

  /**
   * Convert an AgentKit MCP server config to SDK format.
   */
  private toSdkFormat(
    name: string,
    config: McpServerConfig,
  ): SdkMcpServerConfig {
    if (config.type === "stdio") {
      const sdkConfig: SdkMcpServerConfig = {
        type: "stdio",
        command: config.command,
        args: config.args,
      };

      // Resolve env vars in the server's environment
      if (config.env) {
        sdkConfig.env = {};
        for (const [key, value] of Object.entries(config.env)) {
          sdkConfig.env[key] = interpolateEnvVars(value);
        }
      }

      this.logger.debug(`Resolved MCP server "${name}" (stdio)`, {
        command: config.command,
        args: config.args,
      });

      return sdkConfig;
    }

    if (config.type === "http") {
      const sdkConfig: SdkMcpServerConfig = {
        type: "http",
        url: config.url,
      };

      if (config.headers) {
        sdkConfig.headers = {};
        for (const [key, value] of Object.entries(config.headers)) {
          sdkConfig.headers[key] = interpolateEnvVars(value);
        }
      }

      this.logger.debug(`Resolved MCP server "${name}" (http)`, {
        url: config.url,
      });

      return sdkConfig;
    }

    throw new Error(`Unknown MCP server type for "${name}"`);
  }
}
