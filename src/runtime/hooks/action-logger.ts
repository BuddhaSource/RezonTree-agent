import type { Logger } from "../../logger/index.js";

/**
 * Post-tool-use hook that logs every tool execution for observability.
 */
export function createActionLoggerHook(logger: Logger) {
  return async (toolName: string, toolInput: unknown) => {
    logger.debug("Tool executed", {
      tool: toolName,
      input_preview:
        typeof toolInput === "string"
          ? toolInput.slice(0, 200)
          : JSON.stringify(toolInput).slice(0, 200),
    });
  };
}
