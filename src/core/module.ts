// core/module.ts — Module base class.
//
// Each subdirectory under modules/ ships a Module subclass that
// declares: which migrations it owns, which CLI commands it adds,
// which signals it emits. The framework loads modules in order of
// `INSTALLED_MODULES` from settings, calls `register()` to wire signal
// handlers + commands, then runs migrations.
//
// Modules don't import each other directly. Cross-module communication
// goes through signals (core/signals.ts) and shared DB tables.

import type { Command } from "commander";

export interface MigrationFile {
  /** 0001, 0002, … — strict numeric ordering within a module. */
  id: string;
  /** Absolute path or import-relative path to the .sql file. */
  path: string;
  /** Optional description for `manage migrate --plan`. */
  description?: string;
}

export interface ModuleConfig {
  /** Slug used in INSTALLED_MODULES. */
  name: string;

  /** Migration files this module owns. Run in `id` order. */
  migrations(): MigrationFile[];

  /** Wire CLI commands onto a parent commander program. */
  registerCommands?(program: Command): void;

  /** Wire signal handlers / startup hooks. Runs once at boot. */
  ready?(): void | Promise<void>;
}

export abstract class Module implements ModuleConfig {
  abstract readonly name: string;
  abstract migrations(): MigrationFile[];
  registerCommands?(program: Command): void;
  ready?(): void | Promise<void>;
}

/** Module loader. Imports each module's index.ts which exports `default`. */
export async function loadModules(names: string[]): Promise<ModuleConfig[]> {
  const out: ModuleConfig[] = [];
  for (const name of names) {
    const mod = (await import(`../modules/${name}/index.js`)) as {
      default: ModuleConfig;
    };
    if (!mod.default) {
      throw new Error(`Module "${name}" did not export a default ModuleConfig`);
    }
    out.push(mod.default);
  }
  return out;
}
