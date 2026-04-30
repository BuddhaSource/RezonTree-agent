// core/index.ts — public surface for the core framework layer.

export {
  loadSettings,
  getSettings,
  resetSettingsForTests,
  type Settings,
  type Network,
} from "./settings.js";
export { getDb, getRawConnection, closeDb } from "./db.js";
export { getLogger } from "./logger.js";
export { createSignal, type Signal } from "./signals.js";
export { Module, loadModules, type ModuleConfig, type MigrationFile } from "./module.js";
export {
  buildMigrationPlan,
  runPendingMigrations,
  type MigrationPlanEntry,
} from "./migrations.js";
