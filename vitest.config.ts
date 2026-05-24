import { defineConfig } from "vitest/config";

// Exclude the stale `.claude/worktrees/*` git worktrees from the test
// run. Those are detached checkpoints of old branches; vitest's default
// glob would otherwise pick up their *.test.ts files and double-count
// (or run stale, since-removed) suites. The live test surface is
// src/**, scripts/**, and mcp-servers/**.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/worktrees/**",
    ],
  },
});
