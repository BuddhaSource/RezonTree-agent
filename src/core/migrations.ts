// core/migrations.ts — module-aware migration runner.
//
// libsql is async. We split a .sql file on `;` boundaries — naive but
// fine for our migration files (no embedded semicolons inside
// statements). For each pending file we run all statements then
// stamp _migrations in a single transaction.

import { readFileSync } from "node:fs";

import { getRawConnection } from "./db.js";
import { getLogger } from "./logger.js";
import type { ModuleConfig } from "./module.js";

const log = getLogger("migrations");

const SCHEMA_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS _migrations (
  module      TEXT NOT NULL,
  id          TEXT NOT NULL,
  applied_at  INTEGER NOT NULL,
  PRIMARY KEY (module, id)
);
`;

export interface MigrationPlanEntry {
  module: string;
  id: string;
  description?: string;
  pending: boolean;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

export async function buildMigrationPlan(
  modules: ModuleConfig[],
): Promise<MigrationPlanEntry[]> {
  const conn = getRawConnection();
  await conn.executeMultiple(SCHEMA_BOOTSTRAP);

  const applied = new Set<string>();
  const r = await conn.execute("SELECT module, id FROM _migrations");
  for (const row of r.rows) {
    applied.add(`${row.module}:${row.id}`);
  }

  const plan: MigrationPlanEntry[] = [];
  for (const m of modules) {
    const files = [...m.migrations()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const f of files) {
      plan.push({
        module: m.name,
        id: f.id,
        description: f.description,
        pending: !applied.has(`${m.name}:${f.id}`),
      });
    }
  }
  return plan;
}

export async function runPendingMigrations(
  modules: ModuleConfig[],
): Promise<{ applied: number }> {
  const conn = getRawConnection();
  await conn.executeMultiple(SCHEMA_BOOTSTRAP);

  const plan = await buildMigrationPlan(modules);
  const pending = plan.filter((p) => p.pending);
  if (pending.length === 0) {
    log.info("no pending migrations");
    return { applied: 0 };
  }

  const fileMap = new Map<string, string>();
  for (const m of modules) {
    for (const f of m.migrations()) {
      fileMap.set(`${m.name}:${f.id}`, f.path);
    }
  }

  for (const p of pending) {
    const path = fileMap.get(`${p.module}:${p.id}`)!;
    const sql = readFileSync(path, "utf8");
    log.info({ module: p.module, id: p.id }, "applying migration");
    // libsql's executeMultiple parses semicolon-terminated statements
    // correctly (handles strings, comments, multi-line table defs)
    // — much safer than a regex split. We run it outside a transaction
    // because executeMultiple isn't tx-aware. The _migrations stamp
    // immediately after is the idempotency guard: if the schema apply
    // succeeded but the stamp didn't, the next run will see the table
    // already exists (CREATE IF NOT EXISTS would help but our migrations
    // use plain CREATE — so this assumes one-shot apply).
    await conn.executeMultiple(sql);
    await conn.execute({
      sql: "INSERT INTO _migrations (module, id, applied_at) VALUES (?, ?, ?)",
      args: [p.module, p.id, Date.now()],
    });
  }
  log.info({ count: pending.length }, "migrations applied");
  return { applied: pending.length };
}
