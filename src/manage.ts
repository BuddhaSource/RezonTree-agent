#!/usr/bin/env node
// manage.ts — CLI entry point. Django's manage.py equivalent.
//
// Usage:
//   pnpm tsx src/manage.ts --settings testnet migrate
//   pnpm tsx src/manage.ts --settings testnet wallets register --provider hd --hd-index 1
//   pnpm tsx src/manage.ts --settings testnet wallets list
//
// The --settings flag picks which settings module to load (testnet or
// mainnet). Defaults to env RT_SETTINGS or "mainnet".

import "dotenv/config";
import { Command } from "commander";

import { loadSettings } from "./core/settings.js";
import { loadModules } from "./core/module.js";
import {
  buildMigrationPlan,
  runPendingMigrations,
} from "./core/migrations.js";
import { getLogger } from "./core/logger.js";

async function main() {
  const program = new Command();
  program
    .name("rezontree-agent")
    .description("RezonTree agent — Django-style modular CLI.")
    .version("0.2.0")
    .option(
      "-s, --settings <network>",
      "Settings module: testnet | mainnet",
      process.env.RT_SETTINGS ?? "mainnet",
    )
    .hook("preAction", async (thisCommand) => {
      // Load settings before any subcommand action runs. This lets
      // module commands assume `getSettings()` returns a valid object.
      const network = thisCommand.opts().settings as "testnet" | "mainnet";
      if (network !== "testnet" && network !== "mainnet") {
        throw new Error(`--settings must be testnet | mainnet (got ${network})`);
      }
      await loadSettings(network);
    });

  // Load INSTALLED_MODULES once we know settings, then attach their
  // commands. We do this lazily in the preAction hook, but commander
  // needs commands registered before parse(). So pre-load minimally.
  await loadSettings(
    (process.argv.find((_, i, a) =>
      a[i - 1] === "--settings" || a[i - 1] === "-s",
    ) as "testnet" | "mainnet" | undefined) ??
      (process.env.RT_SETTINGS as "testnet" | "mainnet" | undefined) ??
      "testnet",
  );

  const { getSettings } = await import("./core/settings.js");
  const settings = getSettings();
  const modules = await loadModules(settings.INSTALLED_MODULES);

  // ── Built-in commands ──────────────────────────────────────────────

  program
    .command("migrate")
    .description("Apply pending migrations across all installed modules.")
    .option("--plan", "Print the plan without applying.")
    .action(async (opts) => {
      const log = getLogger("manage");
      if (opts.plan) {
        const plan = await buildMigrationPlan(modules);
        for (const p of plan) {
          const tag = p.pending ? "PENDING" : "applied";
          console.log(`${tag.padEnd(8)} ${p.module}/${p.id} ${p.description ?? ""}`);
        }
        return;
      }
      const result = await runPendingMigrations(modules);
      log.info({ applied: result.applied }, "migrate complete");
    });

  program
    .command("modules")
    .description("List installed modules.")
    .action(() => {
      console.log(JSON.stringify({
        network: settings.NETWORK,
        installed: modules.map((m) => m.name),
      }, null, 2));
    });

  program
    .command("settings")
    .description("Print resolved settings (secrets redacted).")
    .action(() => {
      console.log(JSON.stringify(settings, null, 2));
    });

  // ── Module-provided commands ───────────────────────────────────────
  for (const m of modules) {
    if (m.registerCommands) m.registerCommands(program);
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────
  for (const m of modules) {
    if (m.ready) await m.ready();
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // Pino's printers can buffer; force a stderr write.
  process.stderr.write(
    `manage: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
