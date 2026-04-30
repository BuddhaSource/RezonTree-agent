// core/db.ts — SQLite + drizzle singleton via @libsql/client.
//
// One database for everything. libsql ships prebuilt binaries (no
// node-gyp), embeds full SQLite, supports the same SQL dialect as
// vanilla SQLite. The `file:` URL scheme points at a local file.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import { getSettings } from "./settings.js";
import { getLogger } from "./logger.js";

let conn: Client | null = null;
let db: LibSQLDatabase | null = null;

export function getDb(): LibSQLDatabase {
  if (db && conn) return db;

  const path = resolve(getSettings().DATABASE_PATH);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  conn = createClient({ url: `file:${path}` });
  db = drizzle(conn);

  // PRAGMAs run synchronously via libsql's executeMultiple.
  // WAL gives us many readers + one writer concurrently.
  void conn.executeMultiple(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);

  getLogger("db").info({ path }, "sqlite opened (libsql)");
  return db;
}

/** Direct libsql client — used by the migration runner for raw exec. */
export function getRawConnection(): Client {
  if (!conn) {
    getDb(); // initialize
  }
  return conn!;
}

export function closeDb(): void {
  if (conn) {
    conn.close();
    conn = null;
    db = null;
  }
}
