// core/logger.ts — pino wrapper. Structured JSON in production,
// pretty-printed in development.

import pino, { type Logger } from "pino";
import { getSettings } from "./settings.js";

let root: Logger | null = null;

export function getLogger(name?: string): Logger {
  if (!root) {
    const level = (() => {
      try {
        return getSettings().LOG_LEVEL;
      } catch {
        return "info";
      }
    })();
    root = pino({
      level,
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss.l" },
            },
    });
  }
  return name ? root.child({ module: name }) : root;
}
