// modules/wallets/schema.ts — drizzle table definitions.
//
// These mirror the SQL migration. Drizzle uses these for typed queries
// in service.ts. Keep field order aligned with the .sql file so manual
// schema review is straightforward.

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const wallets = sqliteTable(
  "wallets",
  {
    address: text("address").primaryKey(),
    network: text("network", { enum: ["testnet", "mainnet"] }).notNull(),
    alias: text("alias"),
    providerType: text("provider_type", {
      enum: ["hd", "imported", "privy"],
    }).notNull(),
    providerData: text("provider_data").notNull(), // JSON-encoded
    active: integer("active").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (t) => [
    index("idx_wallets_network_active").on(t.network, t.active),
    uniqueIndex("idx_wallets_alias_per_network")
      .on(t.network, t.alias)
      .where(sql`alias IS NOT NULL`),
  ],
);

export const walletRoles = sqliteTable(
  "wallet_roles",
  {
    address: text("address")
      .notNull()
      .references(() => wallets.address, { onDelete: "cascade" }),
    role: text("role", { enum: ["sponsor", "resolver", "voter"] }).notNull(),
    enabled: integer("enabled").notNull().default(1),
    dailyBudgetUsd: real("daily_budget_usd"),
  },
  (t) => [primaryKey({ columns: [t.address, t.role] })],
);

export const walletTopics = sqliteTable(
  "wallet_topics",
  {
    address: text("address")
      .notNull()
      .references(() => wallets.address, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull(),
    weight: real("weight").notNull().default(1.0),
  },
  (t) => [primaryKey({ columns: [t.address, t.topicId] })],
);

export const walletSettings = sqliteTable(
  "wallet_settings",
  {
    address: text("address")
      .notNull()
      .references(() => wallets.address, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueJson: text("value_json"),
  },
  (t) => [primaryKey({ columns: [t.address, t.key] })],
);

export type Wallet = typeof wallets.$inferSelect;
export type WalletRole = typeof walletRoles.$inferSelect;
export type WalletTopic = typeof walletTopics.$inferSelect;
